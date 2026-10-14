// 夹具：门**自报前提层失败** —— stdout 是 JSON 且 precondition:true，退出码 2。
// 由来（2026-10-14）：author-material 门在声明缺失/坏 JSON 时正是这样输出；旧规则只看
// 「stdout 是否为空」，于是把它读成"断言失败"，导致 report 出现「失败 1」却同时打印
// 「无待修项：全部门通过」的自相矛盾。这条夹具就是防它复发。
console.log(JSON.stringify({
  gate: 'self-pre',
  ok: false,
  precondition: true,
  count: 0,
  summary: '夹具：门自报前提层失败',
}));
process.exit(2);
