// 夹具：**同时**有 FAIL 与提醒 ⇒ 必须判 fail（提醒不得遮住 FAIL）
console.log("有 1 条 FAIL，另有 1 条提醒");
console.log("WARN_COUNT=1 FAIL_COUNT=1");
process.exit(1);
