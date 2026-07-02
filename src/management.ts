import * as S from "./schemas.ts";
import type { Transport } from "./transport.ts";

/** Typed, zod-validated wrapper over the Management API surface we use. */
export class Management {
  constructor(private readonly t: Transport) {}

  async #json(path: string): Promise<unknown> {
    const res = await this.t.mgmt(path);
    if (!res.ok)
      throw new Error(`GET ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  project(ref: string) {
    return this.#json(`/v1/projects/${ref}`).then((d) => S.Project.parse(d));
  }

  health(ref: string) {
    const svc = "db,pooler,auth,rest,storage,realtime";
    return this.#json(`/v1/projects/${ref}/health?services=${svc}`).then((d) =>
      S.HealthList.parse(d),
    );
  }

  disk(ref: string) {
    return this.#json(`/v1/projects/${ref}/config/disk`).then((d) => S.DiskConfig.parse(d));
  }

  diskUtil(ref: string) {
    return this.#json(`/v1/projects/${ref}/config/disk/util`).then((d) => S.DiskUtil.parse(d));
  }

  pgConfig(ref: string) {
    return this.#json(`/v1/projects/${ref}/config/database/postgres`).then((d) =>
      S.PgConfig.parse(d),
    );
  }

  pooler(ref: string) {
    return this.#json(`/v1/projects/${ref}/config/database/pooler`).then((d) =>
      S.PoolerConfig.parse(d),
    );
  }

  backups(ref: string) {
    return this.#json(`/v1/projects/${ref}/database/backups`).then((d) => S.Backups.parse(d));
  }

  upgrade(ref: string) {
    return this.#json(`/v1/projects/${ref}/upgrade/eligibility`).then((d) =>
      S.UpgradeEligibility.parse(d),
    );
  }

  advisors(ref: string, type: "performance" | "security") {
    return this.#json(`/v1/projects/${ref}/advisors/${type}`).then((d) =>
      S.AdvisorResponse.parse(d),
    );
  }

  apiCounts(ref: string, interval = "1day") {
    return this.#json(
      `/v1/projects/${ref}/analytics/endpoints/usage.api-counts?interval=${interval}`,
    ).then((d) => S.ApiCounts.parse(d).result);
  }

  /** Project API keys (anon / service_role / ...). */
  async apiKeys(ref: string): Promise<Array<{ name: string; api_key: string }>> {
    return (await this.#json(`/v1/projects/${ref}/api-keys`)) as Array<{
      name: string;
      api_key: string;
    }>;
  }

  /** Run a single read-only SQL statement as supabase_read_only_user. */
  async readOnlySql(ref: string, query: string): Promise<S.SqlRow[]> {
    const res = await this.t.mgmt(`/v1/projects/${ref}/database/query/read-only`, {
      method: "POST",
      body: JSON.stringify({ query }),
    });
    if (!res.ok)
      throw new Error(`read-only SQL -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    return S.SqlRows.parse(await res.json());
  }
}
