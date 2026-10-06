import os
import sys
import glob
import mmap

SIGNATURES = {
    'zip': b'\x50\x4B\x03\x04',
    'rar': b'\x52\x61\x72\x21\x1A\x07',
    '7z':  b'\x37\x7A\xBC\xAF\x27\x1C'
}

CHUNK_SIZE = 4 * 1024 * 1024  # 每次搬运 4MB


def split_tuzhong(file_path, progress=None):
    """拆分单个图种文件为「图片 + 压缩包」两个文件。

    参数：
        progress(done, total)：可选进度回调，done 为已处理字节数，total 为总字节数。

    返回字典，status 取值如下：
        skipped_self        脚本自身，跳过
        skipped_missing     文件不存在
        skipped_empty       空文件
        skipped_no_sig      未找到压缩包特征码
        success             拆分成功（ext 为压缩包扩展名）
        error               处理出错（error 为异常信息）
    """
    if os.path.basename(file_path) == os.path.basename(__file__):
        return {'status': 'skipped_self'}

    if not os.path.exists(file_path):
        return {'status': 'skipped_missing'}

    # 遇到空文件直接跳过，防止 mmap 报错
    file_size = os.path.getsize(file_path)
    if file_size == 0:
        return {'status': 'skipped_empty'}

    try:
        found_ext = None
        found_pos = -1

        # 【优化 1】：使用 mmap (内存映射) 极速扫描特征码，不吃内存
        with open(file_path, 'rb') as f:
            with mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
                for ext, sig in SIGNATURES.items():
                    pos = mm.find(sig)
                    if pos != -1 and pos > 0:
                        found_ext = ext
                        found_pos = pos
                        break

        if found_pos == -1:
            return {'status': 'skipped_no_sig'}

        base_name, original_ext = os.path.splitext(file_path)
        if not original_ext:
            original_ext = ".jpg"

        img_path = f"{base_name}_分离出的图片{original_ext}"
        archive_path = f"{base_name}_分离出的压缩包.{found_ext}"

        done = 0
        # 【优化 2】：分块边读边写，全程流式搬运，不整载入内存
        with open(file_path, 'rb') as src, \
             open(img_path, 'wb') as img_f, \
             open(archive_path, 'wb') as arc_f:

            # 第一步：搬运图片部分 (从 0 到 found_pos)
            bytes_to_read = found_pos
            while bytes_to_read > 0:
                chunk = src.read(min(CHUNK_SIZE, bytes_to_read))
                if not chunk:
                    break
                img_f.write(chunk)
                bytes_to_read -= len(chunk)
                done += len(chunk)
                if progress:
                    progress(done, file_size)

            # 第二步：搬运压缩包部分 (游标已在 found_pos，把剩余全部搬过去)
            bytes_to_read = file_size - found_pos
            while bytes_to_read > 0:
                chunk = src.read(min(CHUNK_SIZE, bytes_to_read))
                if not chunk:
                    break
                arc_f.write(chunk)
                bytes_to_read -= len(chunk)
                done += len(chunk)
                if progress:
                    progress(done, file_size)

        return {'status': 'success', 'ext': found_ext}
    except Exception as e:
        return {'status': 'error', 'error': str(e)}


def collect_files(args):
    """根据命令行参数收集待处理文件，返回去重后的路径集合。"""
    args = list(args)
    recursive = "-r" in args
    if recursive:
        args.remove("-r")

    files_to_process = set()

    if recursive:
        if not args:
            args = ["*.*"]
        extensions = [arg[1:].lower() if arg.startswith("*.") else arg.lower() for arg in args]
        for root, dirs, files in os.walk('.'):
            for file in files:
                if "*.*" in args or "*" in args:
                    files_to_process.add(os.path.join(root, file))
                    continue
                for ext in extensions:
                    if file.lower().endswith(ext) or file.lower() == ext:
                        files_to_process.add(os.path.join(root, file))
                        break
    else:
        for arg in args:
            for match in glob.glob(arg):
                if os.path.isfile(match):
                    files_to_process.add(match)

    return files_to_process


if __name__ == "__main__":
    args = sys.argv[1:]
    recursive = "-r" in args

    if not args or (recursive and len(args) == 1):
        if not args:
            print("缺少参数！请在命令后输入文件名，或者使用 -r 参数扫描所有文件夹。")
            print("用法示例:")
            print("  极速处理大文件: python split.py 10GB图种.jpg")
            print("  极速扫描所有子文件夹: python split.py -r")
            sys.exit()

    files_to_process = collect_files(args)

    if not files_to_process:
        print("没有找到符合条件的文件。")
    else:
        if recursive:
            print("正在扫描当前目录及所有子文件夹...")
        print(f"共找到 {len(files_to_process)} 个文件，开始极速提取...")
        for file in files_to_process:
            result = split_tuzhong(file)
            if result['status'] == 'success':
                print(f"[{file}] 分离成功！ -> 提取出 .{result['ext']} 压缩包")
            elif result['status'] == 'skipped_missing':
                print(f"[{file}] 找不到文件，已跳过。")
            elif result['status'] == 'skipped_no_sig':
                print(f"[{file}] 未检测到压缩包特征码，不是图种文件（已跳过）。")
            elif result['status'] == 'skipped_empty':
                print(f"[{file}] 空文件，已跳过。")
            elif result['status'] == 'error':
                print(f"[{file}] 处理出错：{result['error']}")
        print("全部扫描处理完毕！")