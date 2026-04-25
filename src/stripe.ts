interface StripeCustomerSearch {
  data: Array<{ id: string; email: string | null; created: number }>;
  has_more: boolean;
}

interface StripeSubscriptionList {
  data: Array<{
    id: string;
    status: string;
    start_date: number;
    items: { data: Array<{ price: { id: string } }> };
  }>;
  has_more: boolean;
}

const ACTIVE_STATUSES = new Set(["active", "trialing"]);

export interface MembershipResult {
  active: boolean;
  /** Earliest subscription start across all matching subscriptions (Unix seconds). */
  memberSince?: number;
}

export async function findActiveMembership(
  apiKey: string,
  email: string,
  priceIds: string[],
): Promise<MembershipResult> {
  const escaped = email.replace(/"/g, "");
  const query = `email:"${escaped}"`;
  const customers = await stripeFetch<StripeCustomerSearch>(
    apiKey,
    `https://api.stripe.com/v1/customers/search?query=${encodeURIComponent(query)}&limit=10`,
  );
  if (customers.data.length === 0) return { active: false };

  const priceSet = new Set(priceIds);
  let activeFound = false;
  let earliestStart: number | undefined;

  for (const customer of customers.data) {
    const subs = await stripeFetch<StripeSubscriptionList>(
      apiKey,
      `https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(customer.id)}&status=all&limit=100`,
    );
    for (const sub of subs.data) {
      const matchesPrice = sub.items.data.some((item) => priceSet.has(item.price.id));
      if (!matchesPrice) continue;
      if (ACTIVE_STATUSES.has(sub.status)) activeFound = true;
      if (earliestStart === undefined || sub.start_date < earliestStart) {
        earliestStart = sub.start_date;
      }
    }
  }

  return { active: activeFound, memberSince: earliestStart };
}

async function stripeFetch<T>(apiKey: string, url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Stripe ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}
