interface NexudusCoworker {
  Id: number;
  Email: string | null;
  FullName: string | null;
  RegistrationDate: string | null;
  TariffId: number | null;
  TariffName: string | null;
  Active: boolean;
  Archived: boolean;
}

interface NexudusListResponse<T> {
  Records: T[];
  TotalItems: number;
  HasNextPage: boolean;
}

export interface NexudusMembershipResult {
  active: boolean;
  memberSince?: number;
  coworkerId?: number;
  tier?: { name: string };
}

const BASE = "https://spaces.nexudus.com/api";

export async function findActiveMembership(
  apiEmail: string,
  apiPassword: string,
  invoicingBusinessId: string,
  memberEmail: string,
): Promise<NexudusMembershipResult> {
  const filters = new URLSearchParams({
    coworker_Email: memberEmail,
    coworker_Tariff: "notnull",
    coworker_Active: "true",
    coworker_InvoicingBusiness: invoicingBusinessId,
    coworker_Archived: "false",
    size: "1",
  });
  const url = `${BASE}/spaces/coworkers?${filters}`;
  const res = await nexudusFetch<NexudusListResponse<NexudusCoworker>>(
    apiEmail,
    apiPassword,
    url,
  );

  const record = res.Records[0];
  if (!record) return { active: false };

  const memberSince = record.RegistrationDate
    ? Math.floor(new Date(record.RegistrationDate).getTime() / 1000)
    : undefined;

  return {
    active: true,
    memberSince,
    coworkerId: record.Id,
    tier: record.TariffName ? { name: record.TariffName } : undefined,
  };
}

export interface ActiveMember {
  email: string;
  memberSince: number;
}

export async function listActiveMembers(
  apiEmail: string,
  apiPassword: string,
  invoicingBusinessId: string,
): Promise<ActiveMember[]> {
  const out: ActiveMember[] = [];
  let page = 1;
  for (let safety = 0; safety < 50; safety++) {
    const filters = new URLSearchParams({
      coworker_Tariff: "notnull",
      coworker_Active: "true",
      coworker_InvoicingBusiness: invoicingBusinessId,
      coworker_Archived: "false",
      orderBy: "RegistrationDate",
      dir: "1",
      size: "100",
      page: String(page),
    });
    const url = `${BASE}/spaces/coworkers?${filters}`;
    const res = await nexudusFetch<NexudusListResponse<NexudusCoworker>>(
      apiEmail,
      apiPassword,
      url,
    );
    for (const r of res.Records) {
      if (!r.Email || !r.RegistrationDate) continue;
      out.push({
        email: r.Email.toLowerCase(),
        memberSince: Math.floor(new Date(r.RegistrationDate).getTime() / 1000),
      });
    }
    if (!res.HasNextPage || res.Records.length === 0) break;
    page += 1;
  }
  return out;
}

async function nexudusFetch<T>(
  apiEmail: string,
  apiPassword: string,
  url: string,
): Promise<T> {
  const auth = btoa(`${apiEmail}:${apiPassword}`);
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Nexudus ${res.status}: ${redactNexudus(body, apiEmail)}`);
  }
  return (await res.json()) as T;
}

function redactNexudus(text: string, apiEmail: string): string {
  return text.split(apiEmail).join("***");
}
