import re
import time
import requests

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

all_moe_ids = []

for p in range(10):
    url = f"https://icp.gov.moe/moeid.php?p={p}"
    print(f"正在抓取页面 p={p} ...")
    try:
        resp = requests.get(url, headers=headers, timeout=10)
        resp.encoding = resp.apparent_encoding or 'utf-8'
        
        # 匹配萌号链接中的 id 参数
        ids = re.findall(r'join\.php\?id=(\d+)', resp.text)
        print(f"  页面 p={p} 提取到 {len(ids)} 个萌号")
        all_moe_ids.extend(ids)
        time.sleep(0.5)  # 礼貌延迟，避免请求过频
    except Exception as e:
        print(f"  抓取 p={p} 出错: {e}")

# 去重并排序
unique_ids = sorted(list(set(all_moe_ids)))
print(f"\n全部抓取完成，共提取到 {len(unique_ids)} 个可用萌号！")

# 导出为文本文件
with open("moe_ids.txt", "w", encoding="utf-8") as f:
    for moe_id in unique_ids:
        f.write(f"{moe_id}\n")

print("已成功保存至本地 moe_ids.txt")