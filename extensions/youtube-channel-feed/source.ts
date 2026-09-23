export function createSource(deps) {
  const FEED_URL = "https://www.youtube.com/feeds/videos.xml?channel_id=UCW5OrUZ4SeUYkUg1XqcjFYA";

  function decode(text) {
    return text
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  }

  function tag(block, name) {
    const escaped = name.replace(/:/g, "\\:");
    const m = block.match(new RegExp("<" + escaped + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + escaped + ">"));
    return m ? decode(m[1]).trim() : "";
  }

  function attr(block, tagName, attrName) {
    const m = block.match(new RegExp("<" + tagName + "\\s[^>]*?" + attrName + '="([^"]*)"'));
    return m ? decode(m[1]) : "";
  }

  return {
    async poll(cursor) {
      const res = await fetch(FEED_URL);
      if (!res.ok) {
        throw new Error("YouTube feed request failed: " + res.status + " " + res.statusText);
      }
      const xml = await res.text();

      const channelName = tag(xml.replace(/<entry>[\s\S]*?<\/entry>/g, ""), "title");
      const lastSeen = cursor ? Date.parse(cursor) : NaN;

      const items = [];
      let newest = Number.isNaN(lastSeen) ? 0 : lastSeen;
      let newestIso = cursor || null;

      const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
      let match;
      while ((match = entryRe.exec(xml)) !== null) {
        const block = match[1];
        const videoId = tag(block, "yt:videoId");
        if (!videoId) continue;

        const publishedIso = tag(block, "published");
        const publishedMs = Date.parse(publishedIso);

        if (!Number.isNaN(lastSeen) && !Number.isNaN(publishedMs) && publishedMs <= lastSeen) {
          continue;
        }

        if (!Number.isNaN(publishedMs) && publishedMs > newest) {
          newest = publishedMs;
          newestIso = publishedIso;
        }

        const title = tag(block, "title") || "Untitled video";
        const description = tag(block, "media:description");
        const url = attr(block, 'link rel="alternate"', "href") ||
          attr(block, "link", "href") ||
          "https://www.youtube.com/watch?v=" + videoId;

        items.push({
          externalId: "youtube:" + videoId,
          title: title,
          body: description || "New video: " + title,
          url: url,
          metadata: {
            videoId: videoId,
            channel: channelName,
            author: tag(block, "name"),
            published: publishedIso,
            updated: tag(block, "updated"),
            thumbnail: attr(block, "media:thumbnail", "url"),
          },
        });
      }

      // Oldest first so tasks are created in chronological order.
      items.sort((a, b) => Date.parse(a.metadata.published) - Date.parse(b.metadata.published));

      return { items: items, cursor: newestIso };
    },
  };
}