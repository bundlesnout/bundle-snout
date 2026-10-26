const a=require('../analyzer');const assert=require('assert');
const d=new Date().toISOString().slice(0,10);
assert.equal(a.restoreCredits({day:'2000-01-01',today:500}),0);
assert.equal(a.restoreCredits({day:d,today:500,byTag:{scan:400}}),500);
assert.equal(a.creditStats().today,500);assert.equal(a.creditStats().byTag.scan,400);
assert.equal(a.restoreCredits({day:d,today:500}),0,'only once');
const s=a.creditSnapshot();assert.equal(s.today,500);
const {createRadar}=require('../radar');
const r=createRadar({log:()=>{}});
assert.equal(r.restoreBudget({day:'2000-01-01',today:9}),false);
assert.equal(r.restoreBudget({day:d,today:120,deepToday:3}),true);
assert.deepEqual(r.budgetSnapshot(),{day:d,today:120,deepToday:3});
assert.equal(r.restoreBudget({day:d,today:120}),false);
console.log('budget persistence ok');process.exit(0)
