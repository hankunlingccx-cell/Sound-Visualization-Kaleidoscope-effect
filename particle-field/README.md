# Axis Field · 线性万花筒声场

基于根目录 `0.md`（**V1.4 / Linear Kaleidoscope Update**）的实时音乐可视化。

## 快速开始

```bash
cd particle-field
npm install
npm run dev
```

用 Chrome / Edge 打开 `http://127.0.0.1:5173/`，点击 **开始** 并允许麦克风。

## V1.4 要点

- 主体为**连续参数曲线 + 平行线束**（`GL_LINES` MVP；屏幕空间 ribbon mesh 为后续增强）
- 半扇区骨架 → K 次旋转 + 镜像；默认 K=6，可在 6/8/10 交叉淡变
- Core / Inner / Mid / Outer 四层；外层可伸缩触须线束
- 少量沿线微粒（约 5%–15% 亮度）
- medium/high 短拖尾 + 极低 Bloom；关闭后处理仍可读完整拓扑
- `MorphController` 低频自主形变；音频调制约 25%–40%

详见 [`0.md`](../0.md)。
