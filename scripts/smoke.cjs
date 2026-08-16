// The same, via require(), to prove the CJS build resolves.
const { breaker, pipeline, FakeClock, classifyHttp } = require("../dist/index.cjs");
const CB = require("../dist/compat/opossum.cjs");

if (classifyHttp({ status: 422 }) !== "answered") throw new Error("classifier wrong under CJS");

const p = pipeline({ policies: [breaker({ slowCallMs: 1000 })], clock: new FakeClock() });
p.execute({}, () => ({ status: 200 })).then((r) => {
  if (r.status !== 200) throw new Error("execute wrong under CJS");
  const Breaker = CB.default ?? CB;
  const b = new Breaker(async () => "hi");
  return b.fire().then((v) => {
    if (v !== "hi") throw new Error("compat shim wrong under CJS");
    b.shutdown();
    console.log("cjs smoke passed");
  });
});
