import { createServer } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

import { PermissionGate } from "../../src/permissions/index.ts";
import { executeTool, toolDefinitions } from "../../src/tools/index.ts";
import { webFetch } from "../../src/tools/web-fetch.ts";

test("web_fetch 返回文本响应", async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello web");
  }, async (url) => {
    const result = await webFetch({ url });

    assert.equal(result, "hello web");
  });
});

test("web_fetch 清理 HTML 响应", async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`
      <html>
        <style>.hidden { color: red; }</style>
        <script>alert("x")</script>
        <body><h1>Hello&nbsp;Agent</h1><p>Tom &amp; Jerry &lt;ok&gt; &quot;yes&quot;</p></body>
      </html>
    `);
  }, async (url) => {
    const result = await webFetch({ url });

    assert.equal(result, 'Hello Agent Tom & Jerry <ok> "yes"');
  });
});

test("web_fetch 拒绝非 http 协议", async () => {
  const result = await webFetch({ url: "file:///tmp/secret.txt" });

  assert.equal(result, "Error: only http(s) URLs are supported");
});

test("web_fetch 返回 HTTP 错误", async () => {
  await withServer((_req, res) => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("missing");
  }, async (url) => {
    const result = await webFetch({ url });

    assert.equal(result, "HTTP error: 404 Not Found");
  });
});

test("web_fetch 跟随有限次数的同 origin 重定向", async () => {
  await withServer((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { location: "/final" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("same origin");
  }, async (url) => {
    const result = await webFetch({ url: `${url}/start` });

    assert.equal(result, "same origin");
  });
});

test("web_fetch 阻止跨 origin 重定向且不会请求目标站点", async () => {
  let targetRequests = 0;
  await withServer((_req, res) => {
    targetRequests++;
    res.end("secret");
  }, async (targetUrl) => {
    await withServer((_req, res) => {
      res.writeHead(302, { location: targetUrl });
      res.end();
    }, async (sourceUrl) => {
      const result = await webFetch({ url: sourceUrl });

      assert.match(result, /cross-origin redirect blocked/);
      assert.match(result, new RegExp(sourceUrl.replaceAll(".", "\\.")));
      assert.equal(targetRequests, 0);
    });
  });
});

test("web_fetch 与权限描述共同接受大小写不同的 HTTP 协议", async () => {
  await withServer((_req, res) => {
    res.end("normalized");
  }, async (url) => {
    const uppercaseUrl = url.replace("http://", "HTTP://");
    const result = await webFetch({ url: uppercaseUrl });

    assert.equal(result, "normalized");
  });
});

test("web_fetch 根据 max_length 截断响应", async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("abcdef");
  }, async (url) => {
    const result = await webFetch({ url, max_length: 3 });

    assert.equal(result, "abc\n\n[... truncated at 3 characters]");
  });
});

test("web_fetch 注册到工具列表并支持 executeTool 分发", async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("registered");
  }, async (url) => {
    assert.ok(toolDefinitions.some((tool) => tool.name === "web_fetch"));

    const result = await executeTool("web_fetch", { url }, {
      cwd: process.cwd(),
      permissionGate: new PermissionGate(),
      readFileState: new Map(),
    });

    assert.deepEqual(result, { content: "registered", isError: false });
  });
});

test("web_fetch 收到 AbortSignal 后取消请求", async () => {
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  const controller = new AbortController();

  await withServer((_req, _res) => {
    requestStarted();
  }, async (url) => {
    const fetching = webFetch({ url }, controller.signal);
    await started;
    controller.abort();

    await assert.rejects(fetching, (error) => (
      error instanceof Error && error.name === "AbortError"
    ));
  });
});

async function withServer(handler, run) {
  const server = createServer(handler);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);

    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}
