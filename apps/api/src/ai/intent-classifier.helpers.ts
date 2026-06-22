const casualGeneralInputs = [
  "你好",
  "您好",
  "嗨",
  "哈喽",
  "哈啰",
  "hello",
  "hi",
  "hey",
  "在吗",
  "在不在",
  "你在吗",
  "有人吗",
  "早上好",
  "上午好",
  "中午好",
  "下午好",
  "晚上好",
  "辛苦了",
  "谢谢",
  "谢了",
  "多谢",
];

export function isCasualGeneralInput(input: string) {
  const compact = input
    .trim()
    .toLowerCase()
    .replace(/[。！？!?，,.;；:：~～、\s]+$/g, "")
    .replace(/\s+/g, "");

  if (!compact) return false;
  if (casualGeneralInputs.includes(compact)) return true;

  return /^(你好|您好|嗨|哈喽|哈啰)(呀|啊|哈)?$/.test(compact);
}
