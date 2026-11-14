/** Producer/consumer contract over HTTP: list ids, fetch one, claim it, fail+retry, complete; two projects in parallel. */
import { afterEach, describe, expect, it } from "vitest";
import { makeApp, makeDataRoot, POST_HEADERS } from "./helpers.js";

const apps: { app: { close: () => Promise<unknown> } }[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.app.close(); });
const JSON_POST = { ...POST_HEADERS };

async function submit(app: Awaited<ReturnType<typeof makeApp>>["app"], pid: string, qid: string, key: string) {
  const r = await app.inject({ method: "POST", url: `/api/projects/${pid}/questions/${qid}/answers`, headers: JSON_POST,
    payload: JSON.stringify({ questionRevision: 1, answers: [{ fieldId: "response", kind: "choice", optionIds: ["a"] }], idempotencyKey: key }) });
  expect(r.statusCode).toBe(201);
  return r.json().answerId as string;
}

describe("queue consumer contract", () => {
  it("lists compact ids, fetches one, claims it by id, retries after failure and completes", async () => {
    const h = await makeApp(makeDataRoot());
    apps.push(h);
    const a1 = await submit(h.app, "alpha", "Q1", "contract-key-001");
    const a2 = await submit(h.app, "alpha", "Q2", "contract-key-002");

    const list = (await h.app.inject("/api/projects/alpha/queue?state=pending")).json();
    expect(list.items.map((i: { answerId: string }) => i.answerId)).toEqual([a1, a2].sort());
    expect(list.items[0]).toMatchObject({ state: "pending", questionRevision: 1 });
    expect(Object.keys(list.items[0]).sort()).toEqual(["answerId", "questionId", "questionRevision", "state", "submittedAt"]);

    const paged = (await h.app.inject("/api/projects/alpha/queue?state=pending&limit=1")).json();
    expect(paged.items).toHaveLength(1);
    const rest = (await h.app.inject(`/api/projects/alpha/queue?state=pending&limit=1&after=${paged.next}`)).json();
    expect(rest.items).toHaveLength(1);
    expect(rest.next).toBeUndefined();

    const one = (await h.app.inject(`/api/projects/alpha/queue/${a2}`)).json();
    expect(one).toMatchObject({ answerId: a2, questionId: "Q2", processingState: "pending" });

    const claim = await h.app.inject({ method: "POST", url: "/api/projects/alpha/queue/claim", headers: JSON_POST, payload: JSON.stringify({ owner: "worker-1", answerId: a2 }) });
    expect(claim.statusCode).toBe(200);
    expect(claim.json()).toMatchObject({ answerId: a2, lease: { owner: "worker-1" } });
    const again = await h.app.inject({ method: "POST", url: "/api/projects/alpha/queue/claim", headers: JSON_POST, payload: JSON.stringify({ owner: "worker-2", answerId: a2 }) });
    expect(again.statusCode).toBe(409);

    const fail = await h.app.inject({ method: "POST", url: `/api/projects/alpha/queue/${a2}/fail`, headers: JSON_POST, payload: JSON.stringify({ owner: "worker-1", reason: "tool crashed", retryable: true }) });
    expect(fail.statusCode).toBe(200);
    expect((await h.app.inject(`/api/projects/alpha/queue/${a2}`)).json()).toMatchObject({ processingState: "pending", attempts: 1 });

    const reclaim = await h.app.inject({ method: "POST", url: "/api/projects/alpha/queue/claim", headers: JSON_POST, payload: JSON.stringify({ owner: "worker-2", answerId: a2 }) });
    expect(reclaim.json()).toMatchObject({ attempts: 2 });
    const done = await h.app.inject({ method: "POST", url: `/api/projects/alpha/queue/${a2}/complete`, headers: JSON_POST, payload: JSON.stringify({ owner: "worker-2", note: "applied" }) });
    expect(done.statusCode).toBe(200);
    expect((await h.app.inject("/api/projects/alpha/queue?state=processed")).json().items.map((i: { answerId: string }) => i.answerId)).toEqual([a2]);
    expect((await h.app.inject("/api/projects/alpha/queue/ANS-NOPE")).statusCode).toBe(404);
    expect((await h.app.inject("/api/projects/alpha/queue?state=bogus")).statusCode).toBe(400);
  });

  it("independent projects queue and claim concurrently without crossing", async () => {
    const h = await makeApp(makeDataRoot());
    apps.push(h);
    const [a, b] = await Promise.all([submit(h.app, "alpha", "Q3", "contract-key-a"), submit(h.app, "beta", "Q1", "contract-key-b")]);
    const [ca, cb] = await Promise.all([
      h.app.inject({ method: "POST", url: "/api/projects/alpha/queue/claim", headers: JSON_POST, payload: JSON.stringify({ owner: "wa" }) }),
      h.app.inject({ method: "POST", url: "/api/projects/beta/queue/claim", headers: JSON_POST, payload: JSON.stringify({ owner: "wb" }) }),
    ]);
    expect(ca.json().answerId).toBe(a);
    expect(cb.json().answerId).toBe(b);
    expect((await h.app.inject(`/api/projects/beta/queue/${a}`)).statusCode).toBe(404);
  });
});
