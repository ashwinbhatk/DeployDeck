import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { hashPassword, verifyPassword, signSession, verifySession, encryptValue, decryptValue, SESSION_SECONDS } from "../apps/web/lib/security";
import { projectInput, verifyPublicRepo, validBranch } from "../apps/web/lib/validation";
process.env.SESSION_SECRET = randomBytes(32).toString("hex");
process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
test("scrypt salts passwords and rejects incorrect passwords", async () => {
  const a = await hashPassword("a strong password"); const b = await hashPassword("a strong password");
  assert.notEqual(a,b); assert(await verifyPassword("a strong password",a)); assert(!await verifyPassword("wrong",a)); assert(!await verifyPassword("wrong","bad"));
});
test("signed sessions reject expired, altered, future and malformed tokens", () => {
  const id = randomUUID(); const token=signSession(id,100);
  assert.equal(verifySession(token,101),id); assert.equal(verifySession(token,100+SESSION_SECONDS),null);
  assert.equal(verifySession(token,99),null); assert.equal(verifySession(`x${token}`,101),null); assert.equal(verifySession("bad",101),null);
});
test("GCM authenticates ciphertext, context and key with fresh nonces", () => {
  const a=encryptValue("secret", "project:key"); const b=encryptValue("secret", "project:key");
  assert.notEqual(a,b); assert.equal(decryptValue(a,"project:key"),"secret");
  assert.throws(()=>decryptValue(a,"other:key")); const parts=a.split(":"); parts[3]=(parseInt(parts[3].slice(0,2),16)^1).toString(16).padStart(2,"0")+parts[3].slice(2); assert.throws(()=>decryptValue(parts.join(":"),"project:key"));
  assert.equal(decryptValue(encryptValue("","p:k"),"p:k"),"");
  const key=process.env.ENCRYPTION_KEY; process.env.ENCRYPTION_KEY=randomBytes(32).toString("hex");
  assert.throws(()=>decryptValue(a,"project:key")); process.env.ENCRYPTION_KEY=key;
});
test("invalid keys fail closed", () => {
  const key=process.env.ENCRYPTION_KEY; process.env.ENCRYPTION_KEY="bad";
  assert.throws(()=>encryptValue("secret","p:k")); process.env.ENCRYPTION_KEY=key;
});
test("GitHub HEAD has bounded timeout and never follows redirects", async () => {
  let count=0;
  const fetcher = (async (url: string, init: RequestInit) => { count++; assert.equal(url,"https://github.com/example/repo"); assert.equal(init.method,"HEAD"); assert.equal(init.redirect,"manual"); assert(init.signal); return new Response(null,{status:200}); }) as typeof fetch;
  await verifyPublicRepo("https://github.com/example/repo",fetcher);
  for(const url of ["http://github.com/a/b","https://127.0.0.1/a/b","https://github.com@evil.test/a/b","https://github.com/a/..","https://github.com/a/b?x=1","git@github.com:a/b","https://github.com/a/%2e%2e"]) await assert.rejects(verifyPublicRepo(url,fetcher));
  assert.equal(count,1);
  for(const status of [301,302,404,500]) await assert.rejects(verifyPublicRepo("https://github.com/example/repo", (async()=>new Response(null,{status})) as typeof fetch));
  await assert.rejects(verifyPublicRepo("https://github.com/example/repo", (async()=>{throw new Error("timeout")}) as typeof fetch));
});
test("project validation rejects unsafe branches, health paths and environment values", () => {
  for(const branch of ["../main","-main","a..b","a.lock","a/.hidden","a//b","x@{y","a b","a\\b"]) assert(!validBranch(branch),branch);
  assert(validBranch("feature/auth"));
  for(const data of [{port:1.5},{port:0},{health_check_path:"//127.0.0.1"},{environment_variables:{TOKEN:"x\0y"}},{environment_variables:{"BAD-KEY":"x"}},{repo_url:"https://github.com/a/b"}]) assert.throws(()=>projectInput(data,true));
  assert.deepEqual(projectInput({environment_variables:{TOKEN:null}},true),{environment_variables:{TOKEN:null}});
});
