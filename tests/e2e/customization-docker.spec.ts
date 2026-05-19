import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Container, DockerResponse } from "@/app/api/docker/containers/route";
import { UPDATE_SCREENSHOTS } from "./helpers/marketing-screenshot";

/**
 * Screenshots for the Docker Monitoring customization on the marketing
 * site. We never shell out to a real `docker` daemon — CI doesn't have
 * one, and a developer's container list would drift between runs and
 * make the screenshot non-deterministic. Instead, we mock
 * `/api/docker/containers` with a fixture and snap.
 *
 * Three shots (only written when UPDATE_SCREENSHOTS=1):
 *   1. customization-docker.png            — the full dashboard
 *   2. customization-docker-cards.png      — close-up on the aggregate
 *      cards (the "fancy graphics")
 *   3. customization-docker-unavailable.png — the friendly "Docker isn't
 *      running" state, so the marketing card can show graceful degradation.
 */

const SHOTS_DIR = resolve(process.cwd(), "site/screenshots");
if (UPDATE_SCREENSHOTS) mkdirSync(SHOTS_DIR, { recursive: true });

type WorkspaceSummary = { id: string; name: string; rootPath: string };

async function activateClaudiusWorkspace(page: Page) {
  const list = await page.request
    .get("/api/workspaces")
    .then((r) => r.json() as Promise<{ workspaces: WorkspaceSummary[] }>);
  const cwd = process.cwd();
  const ws =
    list.workspaces.find((w) => w.name === "claudius") ??
    list.workspaces.find((w) => w.rootPath === cwd);
  if (ws) {
    await page.request.post(`/api/workspaces/${ws.id}/select`);
  }
}

function fixtureBody(): DockerResponse {
  // Hand-picked container set: a stack the audience will recognise + a
  // mix of healthy/unhealthy/no-check so every badge variant renders.
  const containers: Container[] = [
    {
      id: "8a4f9c2d1b00",
      name: "claudius-postgres",
      image: "postgres:16.2",
      status: "Up 3 days (healthy)",
      state: "running",
      ports: "0.0.0.0:5432->5432/tcp",
      runningFor: "3 days ago",
      health: "healthy",
      cpuPct: 4.7,
      memPct: 18.3,
      memUsageBytes: 728 * 1024 * 1024,
      memLimitBytes: 4 * 1024 * 1024 * 1024,
      blockIOBytes: 1.4 * 1024 * 1024 * 1024,
      netIOBytes: 412 * 1024 * 1024,
    },
    {
      id: "fcd1112233aa",
      name: "redis-cache",
      image: "redis:7.2-alpine",
      status: "Up 6 hours (healthy)",
      state: "running",
      ports: "0.0.0.0:6379->6379/tcp",
      runningFor: "6 hours ago",
      health: "healthy",
      cpuPct: 1.2,
      memPct: 3.1,
      memUsageBytes: 124 * 1024 * 1024,
      memLimitBytes: 4 * 1024 * 1024 * 1024,
      blockIOBytes: 88 * 1024 * 1024,
      netIOBytes: 1.2 * 1024 * 1024 * 1024,
    },
    {
      id: "77a55b921ff0",
      name: "claudius-app",
      image: "claudius:dev",
      status: "Up 2 hours",
      state: "running",
      ports: "0.0.0.0:3000->3000/tcp",
      runningFor: "2 hours ago",
      health: null,
      cpuPct: 23.4,
      memPct: 31.7,
      memUsageBytes: 1.27 * 1024 * 1024 * 1024,
      memLimitBytes: 4 * 1024 * 1024 * 1024,
      blockIOBytes: 312 * 1024 * 1024,
      netIOBytes: 904 * 1024 * 1024,
    },
    {
      id: "0011aabbccdd",
      name: "nginx-edge",
      image: "nginx:1.27-alpine",
      status: "Up 12 days (unhealthy)",
      state: "running",
      ports: "0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp",
      runningFor: "12 days ago",
      health: "unhealthy",
      cpuPct: 0.3,
      memPct: 1.4,
      memUsageBytes: 56 * 1024 * 1024,
      memLimitBytes: 4 * 1024 * 1024 * 1024,
      blockIOBytes: 24 * 1024 * 1024,
      netIOBytes: 7.4 * 1024 * 1024 * 1024,
    },
    {
      id: "5555eeff7788",
      name: "otel-collector",
      image: "otel/opentelemetry-collector-contrib:0.96.0",
      status: "Up 40 minutes (health: starting)",
      state: "running",
      ports: "4317-4318/tcp",
      runningFor: "40 minutes ago",
      health: "starting",
      cpuPct: 2.8,
      memPct: 4.9,
      memUsageBytes: 198 * 1024 * 1024,
      memLimitBytes: 4 * 1024 * 1024 * 1024,
      blockIOBytes: 14 * 1024 * 1024,
      netIOBytes: 222 * 1024 * 1024,
    },
    {
      id: "9988aabbccdd",
      name: "minio-storage",
      image: "minio/minio:RELEASE.2024-04-18",
      status: "Up 1 day (healthy)",
      state: "running",
      ports: "0.0.0.0:9000-9001->9000-9001/tcp",
      runningFor: "1 day ago",
      health: "healthy",
      cpuPct: 1.9,
      memPct: 6.3,
      memUsageBytes: 256 * 1024 * 1024,
      memLimitBytes: 4 * 1024 * 1024 * 1024,
      blockIOBytes: 3.1 * 1024 * 1024 * 1024,
      netIOBytes: 1.8 * 1024 * 1024 * 1024,
    },
  ];
  return { status: "ok", containers, sampledAt: Date.now() };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("customization · docker monitoring screenshots", () => {
  test("customization-docker (overview)", async ({ page }) => {
    await page.route("**/api/docker/containers**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(fixtureBody()),
      });
    });
    await page.goto("/docker", { waitUntil: "load" });
    await expect(page.getByTestId("docker-dashboard")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("docker-containers-table")).toBeVisible();
    // Settle: let the donut gauges finish drawing.
    await page.waitForTimeout(400);
    if (UPDATE_SCREENSHOTS) {
      await page.screenshot({
        path: resolve(SHOTS_DIR, "customization-docker.png"),
        fullPage: false,
      });
    }
  });

  test("customization-docker-cards (close-up)", async ({ page }) => {
    await page.route("**/api/docker/containers**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(fixtureBody()),
      });
    });
    await page.goto("/docker", { waitUntil: "load" });
    const cards = page.getByTestId("docker-cards");
    await expect(cards).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(400);
    // Tight crop on just the four aggregate cards — the "graphics" hero
    // shot for the marketing card.
    if (UPDATE_SCREENSHOTS) {
      await cards.screenshot({
        path: resolve(SHOTS_DIR, "customization-docker-cards.png"),
      });
    }
  });

  test("customization-docker-unavailable (graceful degradation)", async ({ page }) => {
    await page.route("**/api/docker/containers**", async (route) => {
      const body: DockerResponse = {
        status: "unavailable",
        reason: "docker-daemon-down",
        detail: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
        containers: [],
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });
    await page.goto("/docker", { waitUntil: "load" });
    await expect(page.getByTestId("docker-unavailable")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(200);
    if (UPDATE_SCREENSHOTS) {
      await page.screenshot({
        path: resolve(SHOTS_DIR, "customization-docker-unavailable.png"),
        fullPage: false,
      });
    }
  });
});
