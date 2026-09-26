import os
import sys
import glob
import mmap
import shutil

def split_tuzhong(file_path):
    # 自动跳过脚本自身
    if os.path.basename(file_path) == os.path.basename(__file__):
        return

    if not os.path.exists(file_path):
        print(f"[{file_path}] 找不到文件，已跳过。")
        return

    # 遇到空文件直接跳过，防止 mmap 报错
    file_size = os.path.getsize(file_path)
    if file_size == 0:
        return

    signatures = {
        'zip': b'\x50\x4B\x03\x04',
        'rar': b'\x52\x61\x72\x21\x1A\x07',
        '7z':  b'\x37\x7A\xBC\xAF\x27\x1C'
    }

    found_ext = None
    found_pos = -1

    # 【优化 1】：使用 mmap (内存映射) 极速扫描特征码，不吃内存
    with open(file_path, 'rb') as f:
        with mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
            for ext, sig in signatures.items():
                pos = mm.find(sig)
                if pos != -1 and pos > 0:
                    found_ext = ext
                    found_pos = pos
                    break

    # 如果找到了特征码
    if found_pos != -1:
        base_name, original_ext = os.path.splitext(file_path)
        if not original_ext:
            original_ext = ".jpg"

        img_path = f"{base_name}_分离出的图片{original_ext}"
        archive_path = f"{base_name}_分离出的压缩包.{found_ext}"

        # 【优化 2】：分块边读边写 (设置每次搬运 4MB)
        chunk_size = 4 * 1024 * 1024

        with open(file_path, 'rb') as src, \
             open(img_path, 'wb') as img_f, \
             open(archive_path, 'wb') as arc_f:

            # 第一步：搬运图片部分 (从 0 到 found_pos)
            bytes_to_read = found_pos
            while bytes_to_read > 0:
                # 每次最多读 4MB，如果剩下的不到 4MB，就全读完
                chunk = src.read(min(chunk_size, bytes_to_read))
                if not chunk:
                    break
                img_f.write(chunk)
                bytes_to_read -= len(chunk)

            # 第二步：搬运压缩包部分 (此时游标已经刚好在 found_pos 位置，直接把剩下的全部搬过去)
            shutil.copyfileobj(src, arc_f, chunk_size)

        print(f"[{file_path}] 分离成功！ -> 提取出 .{found_ext} 压缩包")

if __name__ == "__main__":
    args = sys.argv[1:]

    recursive = False
    if "-r" in args:
        recursive = True
        args.remove("-r")

    if not args and not recursive:
        print("缺少参数！请在命令后输入文件名，或者使用 -r 参数扫描所有文件夹。")
        print("用法示例:")
        print("  极速处理大文件: python split.py 10GB图种.jpg")
        print("  极速扫描所有子文件夹: python split.py -r")
        sys.exit()

    if recursive and not args:
        args = ["*.*"]

    files_to_process = set()

    if recursive:
        print("正在扫描当前目录及所有子文件夹...")
        extensions = [arg[1:].lower() if arg.startswith("*.") else arg.lower() for arg in args]

        for root, dirs, files in os.walk('.'):
            for file in files:
                add_file = False
                if "*.*" in args or "*" in args:
                    add_file = True
                else:
                    for ext in extensions:
                        if file.lower().endswith(ext) or file.lower() == ext:
                            add_file = True
                            break

                if add_file:
                    files_to_process.add(os.path.join(root, file))
    else:
        for arg in args:
            for match in glob.glob(arg):
                if os.path.isfile(match):
                    files_to_process.add(match)

    if not files_to_process:
        print("没有找到符合条件的文件。")
    else:
        print(f"共找到 {len(files_to_process)} 个文件，开始极速提取...")
        for file in files_to_process:
            split_tuzhong(file)
        print("全部扫描处理完毕！")
