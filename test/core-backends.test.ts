import assert from "node:assert/strict";
import test from "node:test";
import { createBackend } from "../src/core/backends/factory.ts";
import { createTypeSafeBackend } from "../src/core/backends/typesafe.ts";
import { createOpenAIBackend } from "../src/core/backends/openai.ts";
import { createOpenRouterBackend } from "../src/core/backends/openrouter.ts";
import { createPiClassifierBackend, type RegistryLike } from "../src/core/backends/pi-classifier.ts";
import type { DecisionRequest } from "../src/decision/types.ts";
const request: DecisionRequest = {state:{task:"Fixture task"},questions:{q:{type:"bool",instructions:"Useful?"}}};
const nativeResult = {answers:{q:{type:"bool",probability:0.8}},stopReason:"stop" as const,model:"fixture-native",provider:"fixture-provider"};
function registry(overrides: Partial<RegistryLike> = {}): RegistryLike {
  return {async getApiKeyForProvider() {return "pi-fixture";},getModelsOfType() {return [];},findOfType() {return {id:"fixture"};},async classify() {return nativeResult;},...overrides};
}

for (const [backend,url,model,env] of [
  [createTypeSafeBackend(),"https://api.typesafe.ai/v1/systemone","jev-latest","TYPESAFE_API_KEY"],
  [createOpenAIBackend(),"https://api.openai.com/v1/decisions","gpt-6-luna","OPENAI_API_KEY"],
  [createOpenRouterBackend("~typesafe/jev-latest"),"https://openrouter.ai/api/alpha/decisions","~typesafe/jev-latest","OPENROUTER_API_KEY"],
] as const) test(`${backend.id} direct factory uses exact endpoint/model/auth and normalized bool output`, async () => {
  let calls = 0;
  const deps = {registry: registry(),env:{[env]:"env-fixture"},http:{fetch: async (destination: string | URL | Request,init?: RequestInit) => {
    calls++;assert.equal(destination,url);assert.equal(init?.method,"POST");assert.equal(new Headers(init?.headers).get("authorization"),"Bearer pi-fixture");
    const body = JSON.parse(init!.body as string);assert.equal(body.model,model);
    if (backend.id === "openai") {assert.equal(body.input,JSON.stringify(request.state));assert.equal(body.questions[0].type,"predicate");assert.equal(body.questions[0].name,"q");return Response.json({answers:[{name:"q",type:"predicate",probability:0.8}],usage:{input_tokens:2}});}
    assert.deepEqual(body.state,request.state);assert.equal(body.questions.q.type,"noul");return Response.json({answers:{q:{type:"noul",noul:0.8}},usage:{input_tokens:2}});
  }}};
  const subject = backend.id === "typesafe" ? createTypeSafeBackend(undefined,deps) : backend.id === "openai" ? createOpenAIBackend(undefined,deps) : createOpenRouterBackend(model,deps);
  const result = await subject.decide(request);
  assert.deepEqual(result.answers.q,{type:"bool",probability:0.8});assert.equal(result.backend,backend.id);assert.equal(result.model,model);assert.equal(result.provider,backend.id);assert.equal(calls,1);
});
test("direct model-reported metadata wins over requested model and does not invent usage", async () => {
  const backend = createOpenRouterBackend("typesafe/jev-1.13",{env:{OPENROUTER_API_KEY:"fixture"},http:{fetch:async()=>Response.json({id:"response-fixture",model:"typesafe/jev-1.13-date",provider:"TypeSafe",answers:{q:{type:"noul",noul:0.8}}})}});
  const result = await backend.decide(request);assert.equal(result.model,"typesafe/jev-1.13-date");assert.equal(result.requestId,"response-fixture");assert.equal(result.usage,undefined);
});
test("OpenAI OAuth direct uses env not Pi token, including real request path", async () => {
  let lookedUp = false;
  const backend = createOpenAIBackend(undefined,{registry:registry({getModelsOfType(){return[{provider:"openai",id:"chat"}];},isUsingOAuth(){return true;},async getApiKeyForProvider(){lookedUp=true;return"oauth-fixture";}}),env:{OPENAI_API_KEY:"env-fixture"},http:{fetch:async(_,init)=>{assert.equal(new Headers(init?.headers).get("authorization"),"Bearer env-fixture");return Response.json({answers:[{name:"q",type:"predicate",probability:0.8}]});}}});
  await backend.decide(request);assert.equal(lookedUp,false);
});
test("TypeSafe applies vendor caps before auth/network; other provider does not inherit them", async () => {
  let calls = 0;
  const large: DecisionRequest = {state:{},questions:{q:{type:"score",instructions:"Rate",criteria:Array(11).fill("Level")}}};
  await assert.rejects(createTypeSafeBackend(undefined,{registry:{async getApiKeyForProvider(){calls++;return"fixture";}}}).decide(large),{code:"invalid_request"});assert.equal(calls,0);
  const choice: DecisionRequest = {state:{},questions:{q:{type:"choice",instructions:"Choose",criteria:Object.fromEntries(Array.from({length:256},(_,i)=>[String(i),"Level"]))}}};
  await assert.rejects(createTypeSafeBackend().decide(choice),{code:"invalid_request"});
  await createOpenRouterBackend("fixture/model",{env:{OPENROUTER_API_KEY:"fixture"},http:{fetch:async()=>Response.json({answers:{q:{type:"score",score:5}}})}}).decide(large);
});
test("direct backend validates response/refusal/failure and applies whole auth-plus-request timeout", async () => {
  await assert.rejects(createOpenRouterBackend("fixture/model",{env:{OPENROUTER_API_KEY:"fixture"},http:{fetch:async()=>Response.json({answers:{}})}}).decide(request),{code:"invalid_response",backend:"openrouter"});
  await assert.rejects(createOpenAIBackend(undefined,{env:{OPENAI_API_KEY:"fixture"},http:{fetch:async()=>Response.json({answers:[{name:"q",type:"refusal"}]})}}).decide(request),{code:"refusal",backend:"openai"});
  await assert.rejects(createOpenRouterBackend("fixture/model",{registry:{getApiKeyForProvider:()=>new Promise(()=>{})},env:{OPENROUTER_API_KEY:"fixture"}}).decide(request,{timeoutMs:5}),{code:"timeout"});
  await assert.rejects(createOpenRouterBackend("fixture/model",{env:{OPENROUTER_API_KEY:"fixture"},http:{fetch:()=>new Promise(()=>{})}}).decide(request,{timeoutMs:5}),{code:"timeout"});
});
test("Pi classifier uses exact registry IDs (nested slash), default bool criteria and signal", async () => {
  const subject = createPiClassifierBackend("openrouter","typesafe/jev-1.13",()=>registry({findOfType(type,provider,id){assert.equal(type,"classifier");assert.equal(provider,"openrouter");assert.equal(id,"typesafe/jev-1.13");return{id};},async classify(model,context,options){assert.deepEqual(model,{id:"typesafe/jev-1.13"});assert.equal(context.state,request.state);assert.deepEqual(context.questions.q,{...request.questions.q,criteria:{true:"Yes",false:"No"}});assert.ok(options?.signal instanceof AbortSignal);return nativeResult;}}));
  const result = await subject.decide(request);assert.equal(subject.model,"openrouter/typesafe/jev-1.13");assert.equal(result.backend,"pi");assert.deepEqual(result.answers.q,{type:"bool",probability:0.8});
});
test("Pi preserves choice distribution and score confidence without inventing stripped metadata", async () => {
  const mixed: DecisionRequest = {state:{},questions:{c:{type:"choice",instructions:"Choose",criteria:{a:"A",b:"B"}},s:{type:"score",instructions:"Score",criteria:["Low","High"]},b:{type:"bool",instructions:"Useful?",criteria:{true:"Useful",false:"Unhelpful"}}}};
  const answers = {c:{type:"choice",choice:"a",probabilities:{a:0.8,b:0.2},confidence:0.6},s:{type:"score",score:0.8,confidence:0.6},b:{type:"bool",probability:0.8}};
  const result = await createPiClassifierBackend("typesafe","jev-latest",()=>registry({async classify(_,context){assert.deepEqual(context.questions.b,mixed.questions.b);return{...nativeResult,answers};}})).decide(mixed);
  assert.equal(result.answers.s.probabilities,undefined);assert.deepEqual(result.answers,answers);
});
test("Pi stop errors map safely, missing model is config, timeout/abort remain distinct", async () => {
  for (const [stopReason,errorMessage,code] of [["error","401 private-fixture","auth"],["error","429 private-fixture","rate_limit"],["error","private-fixture","http"],["aborted","private-fixture","aborted"]] as const) {
    await assert.rejects(createPiClassifierBackend("typesafe","jev-latest",()=>registry({async classify(){return{...nativeResult,stopReason,errorMessage};}})).decide(request), (error: unknown) => {assert.equal((error as {code:string}).code,code);assert.ok(!String(error).includes("private"));return true;});
  }
  await assert.rejects(createPiClassifierBackend("typesafe","unknown",()=>registry({findOfType(){return undefined;}})).decide(request),{code:"config"});
  await assert.rejects(createPiClassifierBackend("typesafe","jev-latest",()=>registry({classify:()=>new Promise(()=>{})})).decide(request,{timeoutMs:5}),{code:"timeout"});
  const controller = new AbortController();controller.abort("private");
  await assert.rejects(createPiClassifierBackend("typesafe","jev-latest",()=>registry()).decide(request,{signal:controller.signal}),{code:"aborted"});
});
test("Pi usage carries reported tokens; zero catalog-placeholder cost is not represented as billed", async () => {
  for (const [usage,expected] of [
    [{input:10,output:2,totalTokens:12,cost:{total:0.1}},{inputTokens:10,outputTokens:2,totalTokens:12,cost:0.1}],
    [{input:10,output:2,cost:{total:0}},{inputTokens:10,outputTokens:2}],
    [{cost:{total:0}},undefined],
    [{input:NaN,output:-1,cost:{total:2}},undefined],
  ] as const) {
    const result = await createPiClassifierBackend("typesafe","jev-latest",()=>registry({async classify(){return{...nativeResult,usage};}})).decide(request);assert.deepEqual(result.usage,expected);
  }
});
test("factory supports four explicit selections and rejects invalid model/configuration", () => {
  assert.equal(createBackend({backend:"typesafe"}).model,"jev-latest");assert.equal(createBackend({backend:"openai"}).model,"gpt-6-luna");assert.equal(createBackend({backend:"openrouter",model:"fixture/model"}).id,"openrouter");assert.equal(createBackend({backend:"pi",provider:"typesafe",id:"jev-latest"},{getRegistry:()=>registry()}).id,"pi");
  assert.throws(()=>createBackend({backend:"pi",provider:"typesafe",id:"jev-latest"}),{code:"config"});
  for(const model of [""," ","bad model","bad\nmodel","x".repeat(257)]) assert.throws(()=>createOpenRouterBackend(model),{code:"config"});
});
