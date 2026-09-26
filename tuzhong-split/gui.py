"""tuzhong-split 图形界面。

依赖 tkinterdnd2（支持从资源管理器拖入文件/文件夹）：
    pip install tkinterdnd2
    python gui.py
"""

import os
import queue
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from tkinterdnd2 import DND_FILES, TkinterDnD

from split import split_tuzhong

# 添加文件夹时默认匹配的图片扩展名（图种的宿主通常是图片）
IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tif', '.tiff'}

RESULT_TEXT = {
    'success': '成功',
    'skipped_empty': '空文件',
    'skipped_no_sig': '无特征码',
    'skipped_missing': '不存在',
    'skipped_self': '脚本自身',
    'error': '失败',
}


def human_size(n):
    """把字节数格式化为易读的 B/KB/MB/GB。"""
    n = float(n)
    for unit in ('B', 'KB', 'MB', 'GB', 'TB'):
        if n < 1024 or unit == 'TB':
            if unit == 'B':
                return f"{int(n)} {unit}"
            return f"{n:.1f} {unit}"
        n /= 1024


class SplitGUI:
    def __init__(self, root):
        self.root = root
        root.title("图种分离工具")
        root.geometry("720x520")

        # 主线程与工作线程之间的消息队列
        self.queue = queue.Queue()
        self.worker = None
        self.running = False

        self._build_toolbar()
        self._build_list()
        self._build_log()
        self._enable_dnd()

        # 定期轮询工作线程发来的消息，回到主线程更新 UI
        self.root.after(100, self._poll_queue)

    # ------------------------------------------------------------------ UI
    def _build_toolbar(self):
        bar = ttk.Frame(self.root, padding=(8, 8, 8, 4))
        bar.pack(fill='x')

        ttk.Button(bar, text="添加文件", command=self.add_files).pack(side='left')
        ttk.Button(bar, text="添加文件夹", command=self.add_folder).pack(side='left', padx=(6, 0))
        ttk.Button(bar, text="移除选中", command=self.remove_selected).pack(side='left', padx=(6, 0))
        ttk.Button(bar, text="清空列表", command=self.clear_list).pack(side='left', padx=(6, 0))

        self.start_btn = ttk.Button(bar, text="开始分离", command=self.start)
        self.start_btn.pack(side='right')

    def _build_list(self):
        frame = ttk.Frame(self.root, padding=(8, 0, 8, 0))
        frame.pack(fill='both', expand=True)

        columns = ('path', 'size', 'status')
        self.tree = ttk.Treeview(frame, columns=columns, show='headings', selectmode='extended')
        self.tree.heading('path', text='文件路径')
        self.tree.heading('size', text='大小')
        self.tree.heading('status', text='状态')
        self.tree.column('path', width=460)
        self.tree.column('size', width=90, anchor='e')
        self.tree.column('status', width=90, anchor='center')

        vsb = ttk.Scrollbar(frame, orient='vertical', command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)

        self.tree.pack(side='left', fill='both', expand=True)
        vsb.pack(side='left', fill='y')

        # 文件列表为空时点击「开始分离」无需处理
        ttk.Label(self.root, text="").pack()

    def _build_log(self):
        frame = ttk.Frame(self.root, padding=(8, 4, 8, 8))
        frame.pack(fill='x')

        self.total = ttk.Progressbar(frame, mode='determinate')
        self.total.pack(fill='x')
        self.file_progress = ttk.Progressbar(frame, mode='determinate')
        self.file_progress.pack(fill='x', pady=(4, 0))

        self.log = tk.Text(frame, height=7, state='disabled', wrap='word')
        self.log.pack(fill='x', pady=(6, 0))

    # ------------------------------------------------------------ 列表操作
    def _iid(self, path):
        """用完整路径作为 Treeview 行 id，天然去重。"""
        return path

    def add_files(self):
        paths = filedialog.askopenfilenames(
            title="选择图种文件",
            filetypes=[("图片文件", "*.jpg *.jpeg *.png *.gif *.bmp *.webp *.tif *.tiff"),
                       ("所有文件", "*.*")],
        )
        for p in paths:
            self._insert(p)

    def add_folder(self):
        folder = filedialog.askdirectory(title="选择文件夹（递归扫描图片文件）")
        if folder:
            self._scan_folder(folder)

    def _scan_folder(self, folder):
        found = []
        for root, dirs, files in os.walk(folder):
            for f in files:
                if os.path.splitext(f)[1].lower() in IMAGE_EXTS:
                    found.append(os.path.join(root, f))
        for p in found:
            self._insert(p)
        self._log(f"文件夹扫描到 {len(found)} 个图片文件。")

    def _enable_dnd(self):
        """启用拖拽：从资源管理器把文件/文件夹直接拖入窗口。"""
        for w in (self.root, self.tree):
            w.drop_target_register(DND_FILES)
            w.dnd_bind('<<Drop>>', self._on_drop)

    def _on_drop(self, event):
        for p in self.root.tk.splitlist(event.data):
            if os.path.isdir(p):
                self._scan_folder(p)
            elif os.path.isfile(p):
                self._insert(p)

    def _insert(self, path):
        if path == os.path.abspath(__file__):
            return
        if self.tree.exists(self._iid(path)):
            return
        try:
            size = os.path.getsize(path)
        except OSError:
            return
        self.tree.insert('', 'end', iid=self._iid(path),
                         values=(path, human_size(size), '待处理'))

    def remove_selected(self):
        for iid in self.tree.selection():
            self.tree.delete(iid)

    def clear_list(self):
        if self.running:
            return
        for iid in self.tree.get_children():
            self.tree.delete(iid)
        self.total['value'] = 0
        self.file_progress['value'] = 0

    # ------------------------------------------------------------ 处理流程
    def start(self):
        if self.running:
            return
        iids = self.tree.get_children()
        if not iids:
            messagebox.showinfo("提示", "请先添加要分离的文件。")
            return

        self.running = True
        self.start_btn.config(state='disabled')
        self.total['maximum'] = len(iids)
        self.total['value'] = 0
        self.file_progress['value'] = 0

        # 把要处理的行号顺序交给工作线程
        paths = [self.tree.item(iid, 'values')[0] for iid in iids]
        self.worker = threading.Thread(target=self._run, args=(paths,), daemon=True)
        self.worker.start()

    def _run(self, paths):
        success = 0
        for idx, path in enumerate(paths):
            self._emit({'type': 'file_start', 'idx': idx, 'path': path})

            def progress(done, total, idx=idx):
                self._emit({'type': 'file_progress', 'idx': idx, 'done': done, 'total': total})

            result = split_tuzhong(path, progress=progress)
            self._emit({'type': 'file_done', 'idx': idx, 'path': path, 'result': result})
            if result['status'] == 'success':
                success += 1
        self._emit({'type': 'all_done', 'total': len(paths), 'success': success})

    def _emit(self, msg):
        self.queue.put(msg)

    # ------------------------------------------------------------ UI 更新
    def _poll_queue(self):
        try:
            while True:
                msg = self.queue.get_nowait()
                self._handle(msg)
        except queue.Empty:
            pass
        self.root.after(100, self._poll_queue)

    def _handle(self, msg):
        mtype = msg['type']
        if mtype == 'file_start':
            idx, path = msg['idx'], msg['path']
            iid = self._iid(path)
            if self.tree.exists(iid):
                self.tree.set(iid, 'status', '处理中')
                self.tree.see(iid)
            self.file_progress['value'] = 0
            self._log(f"开始处理：{os.path.basename(path)}")
        elif mtype == 'file_progress':
            idx = msg['idx']
            total = msg['total'] or 1
            pct = msg['done'] * 100.0 / total
            self.file_progress['value'] = pct
        elif mtype == 'file_done':
            idx, path, result = msg['idx'], msg['path'], msg['result']
            iid = self._iid(path)
            status = RESULT_TEXT.get(result['status'], '未知')
            if result['status'] == 'success':
                status = f"成功({result['ext']})"
            elif result['status'] == 'error':
                status = f"失败"
            if self.tree.exists(iid):
                self.tree.set(iid, 'status', status)
            self.file_progress['value'] = 100
            self._log(f"完成：{os.path.basename(path)} -> {status}")
        elif mtype == 'all_done':
            self.running = False
            self.start_btn.config(state='normal')
            self.total['value'] = msg['total']
            self._log(f"全部完成：共 {msg['total']} 个，成功 {msg['success']} 个。")
            messagebox.showinfo("完成", f"处理完成：共 {msg['total']} 个文件，成功 {msg['success']} 个。")

    def _log(self, text):
        self.log.config(state='normal')
        self.log.insert('end', text + "\n")
        self.log.see('end')
        self.log.config(state='disabled')


if __name__ == "__main__":
    root = TkinterDnD.Tk()
    SplitGUI(root)
    root.mainloop()