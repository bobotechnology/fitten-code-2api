const fs = require('fs');
let content = fs.readFileSync('src/parse-xml-tool-calls.js', 'utf8');

// 逐行替换正则模式
const replacements = [
  ['    .replace(/"/g', '    .replace(/"/g'],
  ["    .replace(/'/g", '    .replace(/'/g'],
  ['    .replace(/</g', '    .replace(/</g'],
  ['    .replace(/>/g', '    .replace(/>/g'],
  ['    .replace(/&/g', '    .replace(/&/g'],
];

let changed = 0;
for (const [oldStr, newStr] of replacements) {
  if (content.includes(oldStr)) {
    content = content.replace(oldStr, newStr);
    changed++;
  }
}

// 更新注释
const commentReplacements = [
  ['解码 XML/HTML 实体：', '解码 XML/HTML 实体：" ' < > &'],
  ['注意：& 必须最后解码', '注意：& 必须最后解码'],
];

for (const [oldStr, newStr] of commentReplacements) {
  if (content.includes(oldStr)) {
    content = content.replace(oldStr, newStr);
    changed++;
  }
}

fs.writeFileSync('src/parse-xml-tool-calls.js', content, 'utf8');
console.log('Fixed ' + changed + ' patterns in decodeXmlEntities');
