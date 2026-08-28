import { test, expect } from "@playwright/test";

test("Recent orders + Reorder button + LatestAddress card", async ({ page }) => {
  // Mock the API endpoints the UI calls.
  await page.route("**/api/orders/recent**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        orders: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            state: "delivered",
            items_summary: "Chicken Burger × 2",
            item_count: 2,
            subtotal_paisa: 36000,
            delivery_fee_paisa: 6000,
            total_paisa: 42000,
            created_at: new Date().toISOString(),
            confirmed_at: new Date().toISOString(),
            delivered_at: new Date().toISOString(),
            cancelled_at: null,
          },
        ],
      }),
    });
  });

  await page.route("**/api/address**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        address: {
          id: "22222222-2222-4222-8222-222222222222",
          line1: "House 5, Road 7, Dhanmondi",
          line2: null,
          note_for_rider: "Call before arrival",
          zone_id: "33333333-3333-4333-8333-333333333333",
        },
      }),
    });
  });

  await page.route("**/api/chat", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const reply = body.userText?.startsWith("আগের")
      ? "ঠিক আছে, আগের অর্ডারটি আবার কার্টে রাখলাম।"
      : "হ্যাঁ, কনফার্ম হয়েছে।";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ reply, toolCalls: [], cart: [], tokensUsed: 10 }),
    });
  });

  await page.goto("/");

  // Phone input has a default; just observe the page.
  await expect(page.getByText("Recent orders")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Chicken Burger/)).toBeVisible();
  await expect(page.getByRole("button", { name: /reorder/i }).first()).toBeVisible();
  await expect(page.getByText("Address")).toBeVisible();
  await expect(page.getByText(/House 5, Road 7/)).toBeVisible();
});

test("TrackLatest shows the most-recent order state", async ({ page }) => {
  await page.route("**/api/orders/recent**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        orders: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            state: "preparing",
            items_summary: "Pizza × 1",
            item_count: 1,
            subtotal_paisa: 50000,
            delivery_fee_paisa: 6000,
            total_paisa: 56000,
            created_at: new Date().toISOString(),
            confirmed_at: new Date().toISOString(),
            delivered_at: null,
            cancelled_at: null,
          },
        ],
      }),
    });
  });

  await page.goto("/");
  await expect(page.getByText(/Track latest/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/preparing/i)).toBeVisible();
});
