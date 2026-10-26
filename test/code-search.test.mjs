import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Production uses Pi's TypeScript loader; native Node tests need the same .js -> .ts resolution.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("./") && specifier.endsWith(".js") && context.parentURL?.startsWith(new URL("../", import.meta.url).href)) {
			return nextResolve(new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL).href, context);
		}
		return nextResolve(specifier, context);
	},
});

let moduleId = 0;
async function loadCodeSearch() {
	return import(`../code-search.ts?test=${++moduleId}`);
}

function rpcResponse(payload, sse = false) {
	return new Response(sse ? `event: message\ndata: ${JSON.stringify(payload)}\n\n` : JSON.stringify(payload), {
		headers: { "Content-Type": sse ? "text/event-stream" : "application/json" },
	});
}

for (const [message, sse] of [
	["Unknown tool: get_code_context_exa", true],
	["Tool get_code_context_exa not found", false],
]) {
	test(`falls back and caches missing code-context capability: ${message}`, async (t) => {
		const calls = [];
		t.mock.method(globalThis, "fetch", async (_url, options) => {
			const body = JSON.parse(options.body);
			calls.push(body.params);
			if (body.params.name === "get_code_context_exa") {
				return rpcResponse({ error: { code: -32602, message } }, sse);
			}
			return rpcResponse({ result: { content: [{ type: "text", text: "Python documentation: https://docs.python.org/3/library/asyncio-task.html" }] } });
		});
		const { executeCodeSearch } = await loadCodeSearch();
		const params = { query: "Python asyncio.timeout reschedule when expired", maxTokens: 1000 };
		const result = await executeCodeSearch("first", params);
		assert.equal(result.details.error, undefined);
		assert.equal(result.details.mode, "web-search-fallback");
		assert.match(result.content[0].text, /docs\.python\.org/);
		assert.deepEqual(calls.map((call) => call.name), ["get_code_context_exa", "web_search_exa"]);
		assert.match(calls[1].arguments.query, /code examples documentation/);
		assert.equal(calls[1].arguments.contextMaxCharacters, 4000);
		assert.equal(calls[1].arguments.numResults, 5);
		await executeCodeSearch("second", params);
		assert.deepEqual(calls.map((call) => call.name), ["get_code_context_exa", "web_search_exa", "web_search_exa"]);
	});
}

test("keeps using native code context when supported", async (t) => {
	t.mock.method(globalThis, "fetch", async (_url, options) => {
		assert.equal(JSON.parse(options.body).params.name, "get_code_context_exa");
		return rpcResponse({ result: { content: [{ type: "text", text: "native code context" }] } });
	});
	const { executeCodeSearch } = await loadCodeSearch();
	const result = await executeCodeSearch("native", { query: "asyncio examples" });
	assert.equal(result.details.mode, "code-context");
	assert.equal(result.content[0].text, "native code context");
});

for (const message of ["Unauthorized", "Unknown tool execution error", "Tool dependency not found"]) {
	test(`does not hide unrelated errors with fallback: ${message}`, async (t) => {
		const mock = t.mock.method(globalThis, "fetch", async () => rpcResponse({ error: { code: -32602, message } }));
		const { executeCodeSearch } = await loadCodeSearch();
		const result = await executeCodeSearch("error", { query: "asyncio examples" });
		assert.match(result.details.error, new RegExp(message));
		assert.equal(mock.mock.callCount(), 1);
	});
}

test("propagates cancellation without attempting fallback", async (t) => {
	const mock = t.mock.method(globalThis, "fetch", async () => { throw new DOMException("Aborted", "AbortError"); });
	const { executeCodeSearch } = await loadCodeSearch();
	await assert.rejects(executeCodeSearch("abort", { query: "asyncio examples" }), { name: "AbortError" });
	assert.equal(mock.mock.callCount(), 1);
});

test("surfaces fallback failures rather than reporting success", async (t) => {
	t.mock.method(globalThis, "fetch", async (_url, options) => {
		const name = JSON.parse(options.body).params.name;
		return rpcResponse({ error: { code: -32602, message: name === "get_code_context_exa" ? "Unknown tool: get_code_context_exa" : "Rate limit exceeded" } });
	});
	const { executeCodeSearch } = await loadCodeSearch();
	const result = await executeCodeSearch("fallback-error", { query: "asyncio examples" });
	assert.match(result.details.error, /Rate limit exceeded/);
});
