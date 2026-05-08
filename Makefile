.PHONY: install dev build start lint test test-ui ci

install:
	npm ci

dev:
	npm run dev

build:
	npm run build

start:
	npm start

lint:
	npm run lint

test:
	npx playwright install chromium
	npm run test:e2e

test-ui:
	npm run test:e2e:ui

ci: install lint test
