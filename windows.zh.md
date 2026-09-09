# FastRW：Windows + NVIDIA CUDA 复现指南

[English version](windows.md)

本文档说明如何在 Windows 上配置 FastRW CUDA 环境、运行三个正式测试 Case，并复现论文 Table 1 的主要结果。

## 1. 支持范围

Windows CUDA 后端支持：

- PIRW（基准随机游走）；
- FastRW（FEM 先验 + 残差随机游走 + 路径尾部复用）；
- FasterRW 的 Node.js 后处理；
- Case 1、Case 2、Case 3；
- 与 Apple Metal 后端相同格式的 CSV、JSON、日志和汇总文件。

CUDA 和 Metal 使用不同的 GPU 数学实现，因此不要求逐位相同。正确的复现标准是温度结果在蒙特卡洛统计误差内一致，论文加速比四舍五入后一致。

## 2. 硬件和软件要求

必须具备：

1. Windows 10/11 64 位；
2. NVIDIA GPU；
3. NVIDIA 显卡驱动；
4. CUDA Toolkit；
5. Visual Studio 2019/2022 Build Tools；
6. Miniconda 或 Anaconda；
7. PowerShell。

安装 Visual Studio Build Tools 时必须选择 **Desktop development with C++（使用 C++ 的桌面开发）**，并安装 MSVC x64 工具链和 Windows SDK。

已验证的环境为：

| 组件 | 已验证版本 |
|---|---|
| GPU | NVIDIA GeForce RTX 3050 Ti Laptop GPU |
| Compute Capability | 8.6 |
| CUDA Toolkit | 11.3 |
| Visual Studio Build Tools | 2022 |
| MSVC | 19.44 |
| Python | 3.11 |
| CMake | 4.3.4 |
| Node.js | 26.5 |

> `environment-windows.yml` 只安装 Python、CMake、Node.js 等环境依赖，不会安装 NVIDIA 驱动、CUDA Toolkit 或 Visual Studio 编译器。

## 3. CUDA 架构选择

项目默认使用 `CudaArchitecture=86`，适合 RTX 30 系列。

| GPU | CUDA Architecture |
|---|---:|
| GTX 10 系列 | 61 |
| RTX 20 系列 | 75 |
| RTX 30 系列 | 86 |
| RTX 40 系列 | 89 |

RTX 40 系列建议使用支持架构 89 的较新 CUDA Toolkit。

## 4. 创建 Conda 环境

在项目根目录打开 PowerShell，运行：

```powershell
conda env create -f .\environment-windows.yml
conda activate FastRW
```

以后每次运行项目前，只需激活环境：

```powershell
conda activate FastRW
```

## 5. CUDA 冒烟测试

先使用两个样本验证编译器、CUDA 和数据是否可以正常工作：

```powershell
.\scripts\build_and_run_cuda.ps1 `
    -Config .\configs\tcad_table1\fastrw_case1.json `
    -NumSamples 2 `
    -ThreadsPerBlock 256 `
    -CudaArchitecture 86
```

其他型号 GPU 请按第 3 节修改 `CudaArchitecture`。

成功时应看到类似输出：

```text
CUDA device: NVIDIA ...
CUDA simulation complete in ... seconds
```

并生成：

```text
build-cuda\random_walker_cuda.exe
outputs\tcad_table1\fastrw_case1\direct.csv
outputs\tcad_table1\fastrw_case1\summary.json
```

冒烟测试只用于检查程序能否运行，不能用于论文数据比较。

## 6. 完整运行三个 PIRW Case

PIRW 的论文设置是每个查询点 4096 条路径：

```powershell
.\scripts\run_pirw_direct.ps1 `
    -Case all `
    -NumSamples 4096 `
    -ThreadsPerBlock -1
```

`-1` 表示使用默认的 256 threads/block。

输出目录为：

```text
outputs\tcad_table1\pirw_case1
outputs\tcad_table1\pirw_case2
outputs\tcad_table1\pirw_case3
```

## 7. 完整运行三个 FastRW Case

FastRW 的论文设置是每个查询点 8192 条路径：

```powershell
.\scripts\run_fastrw_direct.ps1 `
    -Case all `
    -NumSamples 8192 `
    -ThreadsPerBlock -1
```

输出目录为：

```text
outputs\tcad_table1\fastrw_case1
outputs\tcad_table1\fastrw_case2
outputs\tcad_table1\fastrw_case3
```

RTX 3050 Ti Laptop 上，六个正式 Case 合计约需 90 分钟。实际时间取决于 GPU 性能、功耗和散热状态。

## 8. 运行 Table 1 后处理

下面的命令会执行三个 Case、两个误差阈值和三种算法，共 18 个论文锁定的 bootstrap 单元：

```powershell
.\scripts\run_table1_post.ps1 `
    -BootstrapTrials 500 `
    -Seed 42
```

输出位于：

```text
outputs\tcad_table1\paper_results
```

这里的加速比是达到相同温度误差时，相对于 PIRW 减少的随机游走工作量：

```text
工作量 = 样本数 N × 每条路径的平均步数
加速比 = PIRW 工作量 / 当前算法工作量
```

它不是 Windows 相对 Mac 的硬件速度比。

## 9. 预期 Table 1 结果

CUDA 结果允许存在微小浮点和蒙特卡洛差异，但四舍五入到论文精度后应接近：

| Case | ε (K) | FastRW | FasterRW |
|---|---:|---:|---:|
| 1 | 0.4 | 5.2× | 8.7× |
| 1 | 0.5 | 5.2× | 10.5× |
| 2 | 0.4 | 5.2× | 10.5× |
| 2 | 0.5 | 5.2× | 8.7× |
| 3 | 0.4 | 3.7× | 24.5× |
| 3 | 0.5 | 4.2× | 28.0× |

已验证的 Windows CUDA 精确结果为：

| Case | ε (K) | FastRW CUDA | FasterRW CUDA |
|---|---:|---:|---:|
| 1 | 0.4 | 5.242× | 8.737× |
| 1 | 0.5 | 5.242× | 10.485× |
| 2 | 0.4 | 5.232× | 10.465× |
| 2 | 0.5 | 5.232× | 8.721× |
| 3 | 0.4 | 3.671× | 24.473× |
| 3 | 0.5 | 4.195× | 27.969× |

## 10. 生成 HTML 报告

在后处理数据生成后运行：

```powershell
python .\scripts\build_html_report.py
```

最终报告为：

```text
outputs\report.html
```

可以直接使用浏览器打开。
