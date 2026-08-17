# knag — development and deployment commands

.DEFAULT_GOAL := help
.PHONY: help setup install dev build check test test-security typecheck \
        migrate deploy verify health logs backup destroy info preflight \
        test-browser

# Command line > .env > default.
-include .env
export

# ENV is a variable, never a target suffix: `make deploy ENV=prod`.
#
# 🔴 dev is the default everywhere, and prod is reached only by saying so. The real
# guard is not this variable — it is that the prod Cloudflare token is not on this
# machine (ADR-0002). A `make deploy ENV=prod` from here fails closed because the
# dev token cannot see prod's D1. This default just means a slip is boring.
ENV ?= dev

# The top level of wrangler.jsonc IS dev, so dev passes no --env at all.
WRANGLER   := pnpm exec wrangler --config worker/wrangler.jsonc
ENV_FLAG   := $(if $(filter-out dev,$(ENV)),--env $(ENV),)
D1_NAME    := $(if $(filter-out dev,$(ENV)),knag,knag-dev)
# 🔴 `:=`, not `?=`. With `?=` a single `HOST` in .env satisfied both environments
# and `make health ENV=dev` checked the prod domain — which does not resolve, so the
# one command that verifies a deployment had never verified dev.
HOST       := $(if $(filter-out dev,$(ENV)),$(PROD_HOST),$(DEV_HOST))

# The account each environment is allowed to touch, from .env. Empty means the
# preflight refuses rather than guesses — see scripts/preflight.sh.
CF_ACCOUNT := $(if $(filter-out dev,$(ENV)),$(CF_ACCOUNT_ID_PROD),$(CF_ACCOUNT_ID_DEV))

VERSION     := $(shell node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
GIT_COMMIT  := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_DIRTY   := $(shell git diff --quiet 2>/dev/null || echo "-dirty")
BUILD_ID    := $(VERSION)+$(GIT_COMMIT)$(GIT_DIRTY)
DEPLOYED_AT := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

BLUE   := \033[34m
GREEN  := \033[32m
YELLOW := \033[33m
BOLD   := \033[1m
RESET  := \033[0m

help: ## Show this help message
	@echo "$(BLUE)knag$(RESET) — $(BUILD_ID)"
	@echo ""
	@echo "Usage: make $(YELLOW)<target>$(RESET) [ENV=dev|prod]   (default: dev)"
	@awk 'BEGIN {FS = ":.*##"} \
		/^##@/ { printf "\n$(BOLD)$(GREEN)%s$(RESET)\n", substr($$0, 5) } \
		/^[a-zA-Z_-]+:.*?##/ { printf "  $(YELLOW)%-16s$(RESET) %s\n", $$1, $$2 }' \
		$(MAKEFILE_LIST)
	@echo ""
	@echo "$(BOLD)Deploying is CI's job.$(RESET) Dev ships on every merge to main; prod"
	@echo "ships from Actions → Deploy to production, manually. The prod Cloudflare"
	@echo "token is not on this machine by design. Runbook: docs/deployment.md."
	@echo ""

##@ Getting Started

setup: install ## Set up the local environment (safe to re-run)
	@node -e 'process.exit(+process.versions.node.split(".")[0] < 22)' \
		&& echo "$(GREEN)✓ Node $$(node -v)$(RESET)" \
		|| echo "$(YELLOW)⚠ Node 22+ required — found $$(node -v)$(RESET)"
	@if [ ! -f .env ] && [ -f .env.example ]; then \
		cp .env.example .env && \
		echo "$(YELLOW)✓ Created .env from template — edit with your values$(RESET)"; \
	else echo "$(GREEN)✓ .env present$(RESET)"; fi
	@grep -q REPLACE_WITH_DEV_D1 worker/wrangler.jsonc \
		&& echo "$(YELLOW)⚠ dev D1 not provisioned — run: pnpm exec wrangler d1 create knag-dev$(RESET)" \
		|| echo "$(GREEN)✓ dev D1 database id set$(RESET)"
	@$(WRANGLER) secret list >/dev/null 2>&1 \
		&& echo "$(GREEN)✓ Cloudflare credentials resolve$(RESET)" \
		|| echo "$(YELLOW)⚠ Cloudflare credentials not configured (.env.local)$(RESET)"
	@echo ""
	@echo "Next:"
	@echo "  1. pnpm exec wrangler d1 create knag-dev   # paste the id into worker/wrangler.jsonc"
	@echo "  2. make migrate ENV=local"
	@echo "  3. make dev"

install: ## Install dependencies
	@pnpm install --frozen-lockfile

##@ Development

dev: build ## Run the Worker locally against a local D1
	@pnpm dev

build: ## Bundle the client (client/src/app.ts -> public/app.js)
	@pnpm build

##@ Test & check

check: ## Typecheck + test — the pre-PR gate, and exactly what CI runs
	@pnpm check

test: ## Run the test suite
	@pnpm test

test-security: ## Run the auth suite alone
	@pnpm test:security

# 🔴 Separate from `check` on purpose — the WebKit download is ~80MB and adds about a
# minute. A gate people stop running is worse than a slower one. This covers what the
# unit suite structurally cannot: rendering, geometry, visibility, focus and caret.
test-browser: ## Run the Playwright suite against WebKit
	@pnpm test:browser

typecheck: ## Typecheck without emitting
	@pnpm typecheck

##@ Database

# 🔴 Migrations are ADDITIVE ONLY. This runs before the deploy, so between the two
# the CURRENTLY DEPLOYED Worker is running against the new schema. Anything
# destructive takes two releases — expand, then contract. See ADR-0002 §3.
migrate: ## Apply D1 migrations (ENV=local|dev|prod)
ifeq ($(ENV),local)
	@$(WRANGLER) d1 migrations apply knag-dev --local
else
	@$(MAKE) --no-print-directory preflight ENV=$(ENV)
	@echo "$(YELLOW)Applying migrations to REMOTE $(D1_NAME) [$(ENV)]$(RESET)"
	@echo "$(YELLOW)Additive only. 'make backup ENV=$(ENV)' first if you have not.$(RESET)"
	@read -p "Continue? [y/N] " c && [ "$$c" = "y" ]
	@$(WRANGLER) $(ENV_FLAG) d1 migrations apply $(D1_NAME) --remote
endif

backup: preflight ## Dump D1 to a timestamped file in backups/ (ENV=dev|prod)
	@bash scripts/backup.sh "$(ENV)" "$(D1_NAME)"

preflight: ## Assert the active Cloudflare credential matches ENV
	@bash scripts/preflight.sh "$(ENV)" "$(CF_ACCOUNT)"

##@ Deploy & operate

deploy: check build preflight ## Deploy the Worker (bakes version + timestamp into /health)
	@if [ "$(ENV)" = "prod" ]; then \
		echo "$(YELLOW)Prod deploys run in CI — the prod token is not on this machine$(RESET)"; \
		echo "$(YELLOW)by design (ADR-0002). Use: Actions → Deploy to production.$(RESET)"; \
		echo ""; \
		read -p "Deploy prod from here anyway? [y/N] " c && [ "$$c" = "y" ]; \
	fi
	@$(WRANGLER) $(ENV_FLAG) deploy \
		--var KNAG_VERSION:"$(BUILD_ID)" \
		--var KNAG_DEPLOYED_AT:"$(DEPLOYED_AT)" \
		--var KNAG_ENV:"$(ENV)"
	@echo "$(GREEN)✓ Deployed $(BUILD_ID) to $(ENV)$(RESET)"

health: ## Assert the live deployment matches this checkout (ENV=dev|prod)
	@bash scripts/health.sh "$(HOST)" "$(BUILD_ID)" "$(ENV)"

verify: health ## Smoke-test the live deployment (ENV=dev|prod)
	@bash scripts/verify.sh "$(HOST)"

logs: ## Tail the deployed Worker (ENV=dev|prod)
	@$(WRANGLER) $(ENV_FLAG) tail --format pretty

##@ Information

info: ## Show what this checkout is configured for
	@echo "build     $(BUILD_ID)"
	@echo "env       $(ENV)"
	@echo "worker    $(if $(filter-out dev,$(ENV)),knag,knag-dev)"
	@echo "d1        $(D1_NAME)"
	@echo "host      $(if $(HOST),$(HOST),<workers.dev>)"
	@echo "node      $$(node -v)"

destroy: ## Delete the Worker and its D1 (CAUTION: deletes the document)
	@echo "$(YELLOW)WARNING: deletes the $(ENV) Worker AND the $(D1_NAME) database.$(RESET)"
	@echo "$(YELLOW)D1 holds the only copy of the document. Run 'make backup ENV=$(ENV)' first.$(RESET)"
	@read -p "Type the word 'destroy' to continue: " c && [ "$$c" = "destroy" ]
	@$(WRANGLER) $(ENV_FLAG) delete
	@$(WRANGLER) $(ENV_FLAG) d1 delete $(D1_NAME)
