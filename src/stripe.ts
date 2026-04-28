interface StripeCustomerSearch {
  data: Array<{ id: string; email: string | null; created: number }>;
  has_more: boolean;
}

interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  start_date: number;
  items: {
    data: Array<{
      price: {
        id: string;
        unit_amount: number | null;
        currency: string;
        recurring: { interval: string } | null;
        product: { id: string; name: string } | string;
      };
    }>;
  };
}

interface StripeSubscriptionList {
  data: StripeSubscription[];
  has_more: boolean;
}

interface StripeEventList {
  data: Array<{
    id: string;
    type: string;
    created: number;
    data: { object: StripeSubscription };
  }>;
  has_more: boolean;
}

interface StripeInvoiceList {
  data: Array<{ id: string; amount_paid: number }>;
  has_more: boolean;
}

const ACTIVE_STATUSES = new Set(["active", "trialing"]);

export interface MembershipResult {
  active: boolean;
  memberSince?: number;
  customerIds: string[];
  tier?: {
    productName: string;
    amountPence: number;
    interval: string;
  };
}

export async function findActiveMembership(
  apiKey: string,
  email: string,
  priceIds: string[],
  productNames?: Map<string, string>,
): Promise<MembershipResult> {
  const escaped = email.replace(/"/g, "");
  const query = `email:"${escaped}"`;
  const customers = await stripeFetch<StripeCustomerSearch>(
    apiKey,
    `https://api.stripe.com/v1/customers/search?query=${encodeURIComponent(query)}&limit=10`,
  );
  if (customers.data.length === 0) return { active: false, customerIds: [] };

  const priceSet = new Set(priceIds);
  let activeFound = false;
  let earliestStart: number | undefined;
  let tier: MembershipResult["tier"] | undefined;
  const customerIds = customers.data.map((c) => c.id);

  for (const customer of customers.data) {
    const url = new URL("https://api.stripe.com/v1/subscriptions");
    url.searchParams.set("customer", customer.id);
    url.searchParams.set("status", "all");
    url.searchParams.set("limit", "100");

    const subs = await stripeFetch<StripeSubscriptionList>(apiKey, url.toString());
    for (const sub of subs.data) {
      const matchingItem = sub.items.data.find((item) => priceSet.has(item.price.id));
      if (!matchingItem) continue;
      if (ACTIVE_STATUSES.has(sub.status)) {
        activeFound = true;
        if (!tier) {
          tier = {
            productName: resolveProductName(matchingItem.price.product, productNames),
            amountPence: matchingItem.price.unit_amount ?? 0,
            interval: matchingItem.price.recurring?.interval ?? "month",
          };
        }
      }
      if (earliestStart === undefined || sub.start_date < earliestStart) {
        earliestStart = sub.start_date;
      }
    }
  }

  return { active: activeFound, memberSince: earliestStart, customerIds, tier };
}

export interface LabStats {
  total: number;
  olderThanUser: number;
  tierBreakdown: Record<string, number>;
  joinedLast30: number;
  leftLast30: number;
}

export async function getLabStats(
  apiKey: string,
  priceIds: string[],
  userStartDate: number,
  productNames?: Map<string, string>,
): Promise<LabStats> {
  const priceSet = new Set(priceIds);
  const now = Math.floor(Date.now() / 1000);
  const cutoff30 = now - 30 * 86400;

  const activeCustomers = new Set<string>();
  const customerEarliestStart = new Map<string, number>();
  const tierBreakdown: Record<string, number> = {};
  let total = 0;
  let olderThanUser = 0;

  let startingAfter: string | undefined;
  for (let page = 0; page < 30; page++) {
    const url = new URL("https://api.stripe.com/v1/subscriptions");
    url.searchParams.set("status", "active");
    url.searchParams.set("limit", "100");
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);

    const res = await stripeFetch<StripeSubscriptionList>(apiKey, url.toString());
    for (const sub of res.data) {
      const matchingItem = sub.items.data.find((item) => priceSet.has(item.price.id));
      if (!matchingItem) continue;
      total++;
      activeCustomers.add(sub.customer);
      const prev = customerEarliestStart.get(sub.customer);
      if (prev === undefined || sub.start_date < prev) {
        customerEarliestStart.set(sub.customer, sub.start_date);
      }
      if (sub.start_date < userStartDate) olderThanUser++;
      const productName = resolveProductName(matchingItem.price.product, productNames);
      tierBreakdown[productName] = (tierBreakdown[productName] ?? 0) + 1;
    }
    if (!res.has_more || res.data.length === 0) break;
    startingAfter = res.data[res.data.length - 1].id;
  }

  let joinedLast30 = 0;
  for (const start of customerEarliestStart.values()) {
    if (start >= cutoff30) joinedLast30++;
  }

  const realLeavers = new Set<string>();
  let eventStartingAfter: string | undefined;
  for (let page = 0; page < 5; page++) {
    const url = new URL("https://api.stripe.com/v1/events");
    url.searchParams.set("type", "customer.subscription.deleted");
    url.searchParams.set("limit", "100");
    url.searchParams.set("created[gte]", String(cutoff30));
    if (eventStartingAfter) url.searchParams.set("starting_after", eventStartingAfter);

    const res = await stripeFetch<StripeEventList>(apiKey, url.toString());
    for (const event of res.data) {
      const sub = event.data.object;
      const matchingItem = sub.items.data.find((item) => priceSet.has(item.price.id));
      if (!matchingItem) continue;
      if (!activeCustomers.has(sub.customer)) {
        realLeavers.add(sub.customer);
      }
    }
    if (!res.has_more || res.data.length === 0) break;
    eventStartingAfter = res.data[res.data.length - 1].id;
  }

  return {
    total,
    olderThanUser,
    tierBreakdown,
    joinedLast30,
    leftLast30: realLeavers.size,
  };
}

export async function getLifetimeContributionPence(
  apiKey: string,
  customerIds: string[],
): Promise<number> {
  let total = 0;
  for (const customerId of customerIds) {
    let startingAfter: string | undefined;
    for (let page = 0; page < 20; page++) {
      const url = new URL("https://api.stripe.com/v1/invoices");
      url.searchParams.set("customer", customerId);
      url.searchParams.set("status", "paid");
      url.searchParams.set("limit", "100");
      if (startingAfter) url.searchParams.set("starting_after", startingAfter);

      const res = await stripeFetch<StripeInvoiceList>(apiKey, url.toString());
      for (const invoice of res.data) {
        total += invoice.amount_paid;
      }
      if (!res.has_more || res.data.length === 0) break;
      startingAfter = res.data[res.data.length - 1].id;
    }
  }
  return total;
}

export interface StripeActiveMember {
  email: string;
  memberSince: number;
}

interface StripeSubscriptionListExpanded {
  data: Array<
    Omit<StripeSubscription, "customer"> & {
      customer: string | { id: string; email: string | null };
    }
  >;
  has_more: boolean;
}

export async function listActiveMembers(
  apiKey: string,
  priceIds: string[],
): Promise<StripeActiveMember[]> {
  const priceSet = new Set(priceIds);
  const earliestByEmail = new Map<string, number>();
  let startingAfter: string | undefined;
  for (let page = 0; page < 30; page++) {
    const url = new URL("https://api.stripe.com/v1/subscriptions");
    url.searchParams.set("status", "active");
    url.searchParams.set("limit", "100");
    url.searchParams.append("expand[]", "data.customer");
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);

    const res = await stripeFetch<StripeSubscriptionListExpanded>(apiKey, url.toString());
    for (const sub of res.data) {
      const matchingItem = sub.items.data.find((item) => priceSet.has(item.price.id));
      if (!matchingItem) continue;
      const customer = sub.customer;
      const email = typeof customer === "object" ? customer.email?.toLowerCase() : null;
      if (!email) continue;
      const prev = earliestByEmail.get(email);
      if (prev === undefined || sub.start_date < prev) {
        earliestByEmail.set(email, sub.start_date);
      }
    }
    if (!res.has_more || res.data.length === 0) break;
    const last = res.data[res.data.length - 1];
    startingAfter = last.id;
  }
  return Array.from(earliestByEmail.entries()).map(([email, memberSince]) => ({
    email,
    memberSince,
  }));
}

export async function getProductNames(apiKey: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let startingAfter: string | undefined;
  for (let page = 0; page < 10; page++) {
    const url = new URL("https://api.stripe.com/v1/products");
    url.searchParams.set("limit", "100");
    url.searchParams.set("active", "true");
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);
    const res = await stripeFetch<{
      data: Array<{ id: string; name: string }>;
      has_more: boolean;
    }>(apiKey, url.toString());
    for (const p of res.data) map.set(p.id, p.name);
    if (!res.has_more || res.data.length === 0) break;
    startingAfter = res.data[res.data.length - 1].id;
  }
  return map;
}

function resolveProductName(
  product: { id: string; name: string } | string,
  map?: Map<string, string>,
): string {
  if (typeof product === "object") return product.name;
  return map?.get(product) ?? "Membership";
}

async function stripeFetch<T>(apiKey: string, url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Stripe ${res.status}: ${redactStripeKeys(body)}`);
  }
  return (await res.json()) as T;
}

function redactStripeKeys(text: string): string {
  return text.replace(/(rk|sk|pk)_(live|test)_[\w-]+/g, "$1_$2_***");
}
