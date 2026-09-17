import type { PollResult, RawItem, TaskSource } from "../types";
import { getAccessToken, type OutlookDeps } from "./auth";

interface GraphMessage {
  id: string;
  subject: string | null;
  bodyPreview: string | null;
  body?: { content: string; contentType: string } | null;
  from?: { emailAddress?: { address?: string; name?: string } } | null;
  receivedDateTime: string;
  webLink?: string | null;
  conversationId?: string | null;
}

const PAGE_SIZE = 25;

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toRawItem(message: GraphMessage): RawItem {
  const html = message.body?.contentType?.toLowerCase() === "html";
  const body = message.body?.content
    ? html
      ? stripHtml(message.body.content)
      : message.body.content.trim()
    : (message.bodyPreview ?? "");

  return {
    externalId: message.id,
    title: message.subject ?? "(no subject)",
    body,
    url: message.webLink ?? undefined,
    metadata: {
      from: message.from?.emailAddress?.address ?? null,
      fromName: message.from?.emailAddress?.name ?? null,
      receivedAt: message.receivedDateTime,
      conversationId: message.conversationId ?? null,
    },
  };
}

export function createOutlookSource(deps: OutlookDeps): TaskSource {
  const http = deps.fetch ?? fetch;

  return {
    id: "outlook",
    async poll(cursor: string | null): Promise<PollResult> {
      const token = await getAccessToken(deps);

      const params = new URLSearchParams({
        $orderby: "receivedDateTime asc",
        $top: String(PAGE_SIZE),
        $select: "id,subject,bodyPreview,body,from,receivedDateTime,webLink,conversationId",
      });
      if (cursor) params.set("$filter", `receivedDateTime gt ${cursor}`);

      // URLSearchParams#toString() encodes spaces as "+" (form-urlencoded),
      // but Graph's OData $filter syntax and the test suite expect "%20".
      const query = params.toString().replace(/\+/g, "%20");

      const response = await http(
        `https://graph.microsoft.com/v1.0/me/messages?${query}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!response.ok) {
        throw new Error(`Graph request failed: ${response.status} ${await response.text()}`);
      }

      const body = (await response.json()) as { value: GraphMessage[] };
      const items = body.value.map(toRawItem);
      const last = body.value.at(-1);

      return { items, cursor: last?.receivedDateTime ?? cursor };
    },
  };
}
