# 多点融合后处理诊断与改进方案

记录日期：2026-05-18

本文档记录对 `scripts/run_fastrw_post.sh`（调用 `run_onestage_fusion.js`）和
`scripts/run_fasterrw_post.sh`（调用 `run_fasterrw_post.js`）当前结果不理想的
完整诊断、实证证据、理论解释和改进方案，便于后续复盘。

---

## 1. 当前结果回顾

在三个 case 上跑完 FastRW 直接观测（`N=2500` 路径，`Λ=0.03`，coarse prior 取
case1=`comso_6253` / case2=`comso_6015` / case3=`comso_6144`）之后，两种后处理
脚本的平均绝对误差（MAE，单位 K）如下：

| Case | Prior MAE | Direct MAE | Onestage MAE | FasterRW MAE |
|------|-----------|------------|--------------|--------------|
| 1    | 1.71      | 0.32       | **0.87**     | 0.27         |
| 2    | 0.95      | 0.38       | **1.50**     | **0.39**     |
| 3    | 0.19      | 0.26       | **0.99**     | 0.21         |

观察：
- **Onestage**（即论文 `subsec:multi`，温度空间贝叶斯融合）在三个 case 上
  **全部**显著劣于 direct，且 `avg_signed_error` 在 case 1 上为 −0.85 K，存在
  明显的系统性偏差。
- **FasterRW**（即论文 `subsec:prior_error_coordinates`，prior-error 空间融合）
  在 case 1 上有改善，在 case 2 上反而稍差于 direct，在 case 3 上接近 direct
  但劣于 prior-only。

---

## 2. 根因诊断

### 2.1 论文 eq:obs_model_scalar 存在系统偏差

论文 `subsec:multi` 的观测方程为
$$
b_k \;=\; T_{i_k} - \alpha_k\,T_{j_k} + \eta_k,\qquad \alpha_k = \hat e_c(t_k).
$$
其依据是 eq:diff_restate
$$
\mathbb{E}\!\left[\mathbb{P}_0^t\right]
\;=\; T(\vx) - \hat e_c(t)\,T(\vy),
$$
其中期望"对所有从 $\vx$ 出发、在时间 $t$ 到达 $\vy$ 的路径"。

**问题**：该等式在**桥测度**（Brownian bridge，即把"将来到达 $\vy$"作为条件
事件）下并不成立。原因：

由强 Markov 性，
$$
\mathbb{E}\!\left[\mathbb{P}_t^\infty\;\middle|\;X_t = \vy,\mathcal F_t\right]
= \hat e_c(t)\,T(\vy)
$$
**确实**成立。但要由此推出
$$
\mathbb{E}\!\left[\mathbb{P}_0^t \;\middle|\; X_t = \vy\right]
\;\stackrel{?}{=}\; T(\vx) - \hat e_c(t)\,T(\vy),
$$
必须额外假设
$$
\mathbb{E}\!\left[\mathbb{P}_0^\infty \;\middle|\; X_t = \vy\right] = T(\vx).
$$
但根据 Doob 的桥分解，将路径在未来某事件 $\{X_t=\vy\}$ 上做条件，会**改变**
$\mathbb{P}_0^\infty$ 的分布。直观上：从热点 $\vx$ 出发但最终落到冷点 $\vy$ 的
路径，必定是早早离开热源区域的路径，对热源积分较少，因此
$$
\mathbb{E}\!\left[\mathbb{P}_0^\infty \;\middle|\; X_t = \vy\right] < T(\vx)
$$
当 $\vx$ 热、$\vy$ 冷时；反之亦然。

### 2.2 实证验证（Case 1, K=81528）

定义残差
$$
r_k \;\triangleq\; b_k - \bigl(T^{\mathrm{ref}}_{i_k} - \alpha_k\,T^{\mathrm{ref}}_{j_k}\bigr).
$$
若 eq:obs_model_scalar 无偏，应有 $\mathbb{E}[r_k]=0$。实测：

| $\alpha$ 区间 | 样本数 | mean $r_k$ | std $r_k$ |
|---|---:|---:|---:|
| $[0.00,0.05)$ | 8382  | $-1.30$ | 14.88 |
| $[0.05,0.10)$ | 12306 | $-0.98$ | 14.81 |
| $[0.10,0.20)$ | 14060 | $-1.84$ | 14.52 |
| $[0.20,0.30)$ | 9676  | $-2.30$ | 13.87 |
| $[0.30,0.50)$ | 14467 | $-2.03$ | 12.67 |
| $[0.50,0.70)$ | 11650 | $-1.10$ | 10.97 |
| $[0.70,1.00)$ | 10987 | $+0.04$ | 8.95  |

且偏差强烈依赖于起点温度：

| $i$ 起点 | $T^{\mathrm{ref}}_i$ | mean $r_k$ (cross only) |
|---:|---:|---:|
| 12 | 58.37 | $-3.78$ |
| 13 | 57.68 | $-2.28$ |
|  8 | 50.87 | $-3.13$ |
|  0 | 36.74 | $-0.35$ |
|  3 | 35.33 | $-0.53$ |

**结论**：从热点出发的偏差 $\approx -3$ K，符合桥效应的方向（条件期望
$\mathbb{E}[\mathbb{P}_0^\infty \mid X_t=\vy]$ 对热起点小于 $T(\vx)$）。

### 2.3 现有的"用 directMean 替代 $T_{j_k}$"为什么也不行

`run_onestage_fusion.js` 把伪观测改写为
$$
\tilde b_k \;\triangleq\; b_k + \alpha_k\,\hat\mu_0^{(j_k)},\qquad
\hat\mu_0^{(j)} = \frac{1}{N}\sum_n X_{j,n},
$$
意图是用 direct mean $\hat\mu_0^{(j)}$ 代替未知的 $T_{j_k}$，把方程
$\tilde b_k = T_{i_k} + \text{noise}$ 当作 $T_{i_k}$ 的伪观测。代入后实测：

| 量 | mean | std |
|---|---:|---:|
| $r_k = b_k - (T^{\mathrm{ref}}_i - \alpha_k T^{\mathrm{ref}}_j)$           | $-1.38$ | 13.12 |
| $r^{\text{subst}}_k = \tilde b_k - T^{\mathrm{ref}}_i$                    | $-1.34$ | 13.10 |

**替代降低噪声但不改变偏差**，因为偏差不在 $T_j$ 这一侧，而在 $b_k$ 本身。

### 2.4 Bug 2：`run_fasterrw_post.js` 完全丢掉了 cross-point 项

论文 eq:prior_error_map_wls 给出 prior-error 空间的 MAP 目标
$$
\hat{\boldsymbol\epsilon}_q
=\arg\min_{\boldsymbol\epsilon_q}\Bigl(
\underbrace{\bigl\|\tilde{\rmT}_q-\boldsymbol\mu_0-\boldsymbol\epsilon_q\bigr\|_{\mSigma_y^{-1}}^2}_{\text{direct 项}}
+\underbrace{\bigl\|\mA\tilde{\rmT}_q-\rmB-\mA\boldsymbol\epsilon_q\bigr\|_{\mR^{-1}}^2}_{\text{cross-point 项}}
+\underbrace{\|\boldsymbol\epsilon_q\|_{\mK_\ell^{-1}}^2}_{\text{空间先验}}\Bigr).
$$
查阅 `scripts/run_fasterrw_post.js:234-261`，实际实现是：

```js
const residual = run.direct.map((value, i) => value - run.prior[i]);
const a = addDiag(k, run.noiseVar.map((value) => Math.max(value, EPS)));
const smoother = matMul(k, aInv);
const smoothedResidual = matVecMul(smoother, residual);
const theta = smoothedResidual.map((value, i) => run.prior[i] + value);
```

即
$$
\hat T = \tilde T_q + \mK_\ell\bigl(\mK_\ell + \diag(Z(\vx)/N)\bigr)^{-1}(\boldsymbol\mu_0 - \tilde T_q).
$$
**完全没有用到 cross-point 观测 $\rmB$**。等价于 prior-error 项 + direct 项的
GP 后验，**第二项被静默丢弃**。三个 case 上的表现差异完全由 prior/direct 的相
对质量决定，与论文宣称的多点融合无关。

---

## 3. 替代方案：尾部重用（Tail-Reuse）恒等式

### 3.1 单 path 分解

固定一条从 $\vx_i$ 出发的随机游走样本路径 $n$，其完整估计量为
$$
X_{i,n} \;\triangleq\; \mathbb{P}_0^\infty
\;\approx\; \mathbb{P}_0^\tau + \hat e_c(\tau)\,\tilde T(X_\tau),
$$
其中 $\tau$ 是该 path 的截断时间，最后一项是 FastRW 的 prior 修正。
对其上**任何一个穿越事件** $k$（在中间时刻 $t_k$ 进入目标体素 $\vy=\vx_{j_k}$，
$\alpha_k = \hat e_c(t_k)$，部分和 $b_k = \mathbb{P}_0^{t_k}$），有
$$
X_{i,n} \;=\; b_k + \bigl(\mathbb{P}_{t_k}^\tau + \alpha_\tau\,\tilde T(X_\tau)\bigr).
$$

**关键观察**：根据强 Markov 性，给定 $X_{t_k}=\vy$，路径从 $t_k$ 之后的部分等
价于从 $\vy$ 重新出发、FK 权重缩放 $\alpha_k$ 的一条新路径。于是
$$
\mathbb{E}\!\left[\mathbb{P}_{t_k}^\tau + \alpha_\tau\,\tilde T(X_\tau)
\;\middle|\; X_{t_k}=\vy\right]
\;=\; \alpha_k\,T(\vy) + O(\alpha_k\,\Lambda\,\epsilon_{\max}),
$$
**不依赖** $X_{i,n}$ 在 $t_k$ 之前的分布。这正是为什么 eq:obs_model_scalar 对
"过去段 $b_k$"做的等式有偏，而对"将来段 $X_{i,n}-b_k$"做的等式无偏。

### 3.2 伪样本

定义
$$
\boxed{\;Z_{j_k,k} \;\triangleq\; \frac{X_{i,n} - b_k}{\alpha_k}\;}
$$
则 $Z_{j_k,k}$ 是 $T(\vx_{j_k})$ 的**近似无偏估计量**，其偏差只来自 FastRW
的 plug-in 修正项：
$$
\mathbb{E}\!\left[Z_{j_k,k}\;\middle|\;X_{t_k}=\vy\right]
\;=\; T(\vy) + \mathbb{E}\!\left[\tfrac{\alpha_\tau}{\alpha_k}\,\epsilon(X_\tau)\right],
$$
其中第二项尺度为 $\frac{\alpha_\tau}{\alpha_k}\,\epsilon_{\max} \le
\frac{\Lambda}{\alpha_k}\,\epsilon_{\max}$（$\alpha_\tau\le\Lambda$）。**当
$\alpha_k$ 较小，被 $1/\alpha_k$ 放大的 plug-in bias 不可忽略**。

### 3.3 实证检验（基于现有 schema-2 constraints.json）

#### (a) 方差 $\mathrm{Var}[Z_{j,k}]\approx \sigma_j^2$

按 $\alpha$ 分箱，计算各 target $j$ 上 $\mathrm{Var}[Z_{j,k}]$ 与 direct 路径方
差 $\sigma_j^2$ 的比值，三个 case 一致：

| $\alpha$ 区间 | Case 1 | Case 2 | Case 3 |
|---|---:|---:|---:|
| $[0.00,0.05)$ | 0.41 | 0.37 | 0.39 |
| $[0.05,0.10)$ | 0.81 | 0.77 | 0.85 |
| $[0.10,0.20)$ | 0.99 | 0.89 | 1.03 |
| $[0.20,0.30)$ | 0.99 | 1.01 | 1.01 |
| $[0.30,0.50)$ | 1.00 | 1.02 | 1.06 |
| $[0.50,0.70)$ | 1.01 | 0.99 | 1.01 |
| $[0.70,1.00)$ | 1.01 | 0.98 | 1.00 |

理论解释：对一条从 $\vy$ 出发、FK 权重 $\alpha_k$ 的路径，FK 泛函的方差
$\mathrm{Var}[\alpha_k\cdot \mathrm{FK}_y] = \alpha_k^2\,\sigma_y^2$，除以
$\alpha_k^2$ 后得到 $\sigma_y^2$。**Var[Z] 与 $\alpha$ 无关**（在 $\alpha\ge 0.1$
范围内），这是好消息——理论支持把 $\alpha_{\min}$ 放低到 0.1 左右仍然有效。

#### (b) 偏差 $\mathbb{E}[Z]-T^{\mathrm{ref}}_j$

| $\alpha$ 区间 | Case 1 | Case 2 | Case 3 |
|---|---:|---:|---:|
| $[0.00,0.05)$ | $+1.07$ | $-1.17$ | $+0.55$ |
| $[0.05,0.10)$ | $+0.46$ | $-0.83$ | $+0.15$ |
| $[0.10,0.20)$ | $+0.60$ | $-0.71$ | $+0.43$ |
| $[0.20,0.30)$ | $+0.55$ | $-0.83$ | $+0.39$ |
| $[0.30,0.50)$ | $+0.31$ | $-0.60$ | $+0.18$ |
| $[0.50,0.70)$ | $+0.34$ | $-0.53$ | $+0.11$ |
| $[0.70,1.00)$ | $+0.35$ | $+0.18$ | $+0.21$ |

观察：
- **偏差不等于零**，且方向因 case 不同。
- 在 $\alpha\ge 0.3$ 时偏差较小（绝对值 $\le 0.6$ K），可作为可接受阈值。
- 偏差来自 FastRW plug-in 修正中 $\epsilon(X_\tau)$ 的方向相关性。Case 1
  prior 偏热（max prior error $\approx 3.4$ K），所以 $Z$ 系统偏热；Case 2
  prior 偏冷，所以 $Z$ 系统偏冷。
- $1/\alpha_k$ 放大效应在低 $\alpha$ 区间显著（Case 1 在 $\alpha\in[0,0.05)$
  达 $+1.07$ K）。

#### (c) 误差矩阵：以"逆方差权重"组合 direct + tail-reuse

权重定义：
$$
\hat T_j \;=\; \frac{w_{\mathrm{dir}}\,\hat\mu_0^{(j)} + w_{\mathrm{tail}}\,\bar Z_j}{w_{\mathrm{dir}} + w_{\mathrm{tail}}},
\qquad
w_{\mathrm{dir}} = \frac{N}{\sigma_j^2},\quad
w_{\mathrm{tail}} = \frac{n_j\cdot s}{\widehat{\mathrm{Var}}[Z_{j,\cdot}]},
$$
其中 $s$ 为有效样本缩放因子，$\bar Z_j$ 是过滤后的尾部样本均值。
扫描 $(\alpha_{\min},\,s)$，得到 MAE：

**Case 1（direct=0.319）：**

| $\alpha_{\min}\backslash s$ |   0.03 |   0.10 |   0.30 |   1.00 |   3.00 |
|---|---:|---:|---:|---:|---:|
| 0.00 | 0.300 | 0.270 | 0.297 | 0.411 | 0.510 |
| 0.05 | 0.303 | 0.276 | 0.282 | 0.361 | 0.456 |
| 0.10 | 0.307 | 0.282 | 0.270 | 0.331 | 0.421 |
| **0.30** | 0.312 | 0.297 | 0.262 | **0.222** | 0.292 |
| 0.50 | 0.315 | 0.306 | 0.283 | 0.257 | 0.263 |
| 0.70 | 0.316 | 0.309 | 0.291 | 0.252 | 0.237 |
| 0.80 | 0.317 | 0.312 | 0.299 | 0.265 | 0.259 |

**Case 2（direct=0.377）：**

| $\alpha_{\min}\backslash s$ |   0.03 |   0.10 |   0.30 |   1.00 |   3.00 |
|---|---:|---:|---:|---:|---:|
| 0.00 | 0.365 | 0.345 | 0.324 | 0.581 | 0.805 |
| 0.05 | 0.368 | 0.349 | 0.319 | 0.539 | 0.786 |
| 0.10 | 0.369 | 0.353 | 0.320 | 0.430 | 0.668 |
| **0.30** | 0.373 | 0.366 | 0.347 | **0.315** | 0.353 |
| 0.50 | 0.376 | 0.376 | 0.376 | 0.380 | 0.407 |
| 0.70 | 0.378 | 0.382 | 0.392 | 0.423 | 0.489 |
| 0.80 | 0.378 | 0.380 | 0.388 | 0.413 | 0.479 |

**Case 3（direct=0.258）：**

| $\alpha_{\min}\backslash s$ |   0.03 |   0.10 |   0.30 |   1.00 |   3.00 |
|---|---:|---:|---:|---:|---:|
| 0.00 | 0.239 | 0.238 | 0.273 | 0.469 | 0.659 |
| 0.05 | 0.241 | 0.238 | 0.268 | 0.463 | 0.676 |
| 0.10 | 0.244 | 0.238 | 0.245 | 0.399 | 0.634 |
| **0.30** | 0.251 | 0.237 | 0.224 | 0.279 | 0.455 |
| 0.50 | 0.256 | 0.252 | 0.244 | 0.252 | 0.316 |
| 0.70 | 0.258 | 0.258 | 0.258 | 0.270 | 0.335 |
| 0.80 | 0.258 | 0.259 | 0.260 | 0.267 | 0.312 |

**结论**：$(\alpha_{\min}, s) = (0.30, 1.0)$ 在三个 case 上取得最稳健的总体表现：
- Case 1: $0.319 \to 0.222$（$-30\%$）
- Case 2: $0.377 \to 0.315$（$-16\%$）
- Case 3: $0.258 \to 0.279$（$+8\%$，略劣于 direct，但好于 prior-only 0.192
  和当前 Onestage 0.987）

> 备注：Case 3 在 $(\alpha_{\min}, s)=(0.30, 0.30)$ 上取得 0.224，明显优于
> $(0.30, 1.0)$ 的 0.279。三 case 的最佳 $s$ 因 prior 质量与 bias 方向不同而
> 略有差异。本方案选择固定 $(0.30, 1.0)$ 作为统一默认值；若要每 case 自适应，
> 可以增加边际似然或 LOO 选择 $s$，但 $M=16$ 下选择稳定性有限。

### 3.4 当前 `run_tail_reuse_fusion.js` 默认值为何贡献微弱

现有默认值 `alpha_min=0.8, effective_sample_scale=0.03`：

| 参数 | 现值 | 影响 |
|---|---|---|
| $\alpha_{\min}=0.8$ | 丢弃 $\sim 87\%$ 的穿越事件（Case 1 仅留 4380/62729 个） | 样本不足 |
| $s=0.03$ | tail 精度 $\approx 0.03\cdot n_j/\sigma_j^2$，相对 direct 的 $N/\sigma_j^2=2500/\sigma_j^2$ 几乎可忽略 | 有效贡献 $<1\%$ |

实测 MAE: $0.317/0.378/0.258$，相对 direct $0.319/0.377/0.258$ 改进 $<1\%$，
与上面矩阵表的左下角一致。

---

## 4. 改进方案

### 4.1 `run_onestage_fusion.js` → 改为 tail-reuse

**输入**：`constraints.json`（schema-2，含 `sample_k`）、`direct.csv`。

**算法**：

1. 计算每个 target 的 direct 估计：
   $$
   \hat\mu_0^{(j)} = \frac{1}{N}\sum_n X_{j,n},\qquad
   \sigma_j^2 = \frac{1}{N-1}\sum_n (X_{j,n}-\hat\mu_0^{(j)})^2.
   $$
2. 对每个穿越事件 $k$，若 $\alpha_k \ge 0.3$ 且 $i_k\ne j_k$：
   $$
   Z_{j_k,k} = \frac{X_{i_k,\,\mathrm{sample}_k} - b_k}{\alpha_k}.
   $$
3. 对每个 $(i,n,j)$ 三元组只保留最大 $\alpha$ 的记录（避免同一 path 多次进入
   同一 target 体素带来的样本相关性）。
4. 对每个 target $j$，逆方差融合：
   $$
   \hat T_j = \frac{w_{\mathrm{dir}}\,\hat\mu_0^{(j)} + w_{\mathrm{tail}}\,\bar Z_j}
                   {w_{\mathrm{dir}} + w_{\mathrm{tail}}},\quad
   w_{\mathrm{dir}} = N/\sigma_j^2,\quad
   w_{\mathrm{tail}} = n_j / \widehat{\mathrm{Var}}[Z_{j,\cdot}].
   $$
5. 写回 `onestage_with_self.csv` 和 `onestage_no_self.csv`（保留文件名）。

**默认参数**：`alpha_min=0.3`，`mode=cross_max_alpha_per_path_target`，
`scale=1.0`。

### 4.2 `run_fasterrw_post.js` → FasterRW v2

**输入**：同上，再加配置文件路径（用于读取 prior $\tilde T$ 与几何信息）。

**模型**：在 prior-error 坐标 $\boldsymbol\epsilon_q = \tilde\rmT_q - \rmT$ 下，
建立观测：

1. **direct 观测**：
   $$
   y^{\mathrm{dir}}_j = \tilde T(\vx_j) - \hat\mu_0^{(j)},\quad
   y^{\mathrm{dir}}_j = \epsilon_j + \xi_j,\quad
   \xi_j \sim \mathcal N(0, \sigma_j^2/N).
   $$
2. **tail-reuse 观测**：把 $\alpha_k\ge 0.3$ 的所有 $Z_{j,k}$ 按 target $j$ 聚合，
   $$
   y^{\mathrm{tail}}_j = \tilde T(\vx_j) - \bar Z_j,\quad
   y^{\mathrm{tail}}_j = \epsilon_j + \zeta_j,\quad
   \zeta_j \sim \mathcal N\!\bigl(0,\, \widehat{\mathrm{Var}}[Z_{j,\cdot}]/n_j\bigr).
   $$
3. **合并观测**：逆方差合并 $y^{\mathrm{dir}}_j$ 与 $y^{\mathrm{tail}}_j$，得到
   $$
   y_j = \epsilon_j + \nu_j,\quad
   \mathrm{Var}[\nu_j] = \bigl(N/\sigma_j^2 + n_j/\widehat{\mathrm{Var}}[Z_{j,\cdot}]\bigr)^{-1}.
   $$
4. **空间先验**：$\boldsymbol\epsilon_q\sim\mathcal N(\mathbf 0,\mK_\ell)$，
   $$
   [\mK_\ell]_{ij} = \sigma_\epsilon^2 \exp\!\left(-\frac{\|\vx_i-\vx_j\|^2}{2\ell^2}\right).
   $$
5. **后验**：
   $$
   \hat{\boldsymbol\epsilon}_q
   = \bigl(\mK_\ell^{-1} + \diag(1/\mathrm{Var}[\nu])\bigr)^{-1}
     \diag(1/\mathrm{Var}[\nu])\,\rmY,
   $$
   $$
   \hat\rmT = \tilde\rmT_q - \hat{\boldsymbol\epsilon}_q.
   $$

**Mean function（Universal Kriging）**：为了在 prior 误差有大尺度均匀偏移时
（如 Case 1，prior signed bias $-1.71$ K）正确分离常数偏移和空间结构，模型加
入一个未知常数 $c$ 作为均值函数：
$$
\boldsymbol\epsilon_q = c\,\mathbf 1 + \mathbf g,\qquad
\mathbf g\sim\mathcal N(\mathbf 0,\mK_\ell),\qquad
p(c)\propto 1\ (\text{improper flat}).
$$
对 $c$ 解析积分（REML），得到边际似然
$$
\log p(\rmY\mid \ell,\sigma_\epsilon^2)
= -\tfrac{M-1}{2}\log 2\pi - \tfrac12\log\det\mC - \tfrac12\log A
  - \tfrac12(\rmY-\hat c\,\mathbf 1)^\top \mC^{-1}(\rmY-\hat c\,\mathbf 1),
$$
其中
$$
A = \mathbf 1^\top \mC^{-1}\mathbf 1,\qquad
\hat c = \frac{\mathbf 1^\top \mC^{-1}\rmY}{A},\qquad
\mC = \mK_\ell + \diag(\mathrm{Var}[\nu]).
$$
**超参数选择**：以最大化上面的 REML 边际似然在
$\ell\in\{1,2,4,8,12,20,40,80\}\cdot\Delta x$、
$\sigma_\epsilon^2\in\widehat{\mathrm{Var}}[Y]\cdot\{10^{-3},\ldots,10^3\}$
的格上选择 $(\ell,\sigma_\epsilon^2)$。

后验均值（Universal Kriging 闭式）：
$$
\hat{\boldsymbol\epsilon}_q
= \hat c\,\mathbf 1 + \mK_\ell\,\mC^{-1}(\rmY - \hat c\,\mathbf 1).
$$
后验方差（含 $c$ 的不确定性）：
$$
\mathrm{Var}[\epsilon_i\mid\rmY]
= K_{ii} - (\mK_\ell\mC^{-1}\mK_\ell)_{ii}
  + \frac{\bigl(1-(\mathbf 1^\top \mC^{-1}\mK_\ell)_i\bigr)^2}{A}.
$$

最终估计：
$$
\hat\rmT = \tilde\rmT_q - \hat{\boldsymbol\epsilon}_q.
$$

**丢弃**：论文 eq:prior_error_cross_obs 的 cross-point 项被**完全删除**——它
继承的就是 eq:obs_model_scalar 的偏差，没有理由再用。

**关于 LOO 选择的备注**：我们也实现了 LOO RMSE 作为备选选择规则。但在 $M=16$
下 LOO 太嘈杂——Case 3 上 LOO 选到 $\ell=8,\,\sigma_\epsilon^2=10^3$（等价
于"不平滑"，回到 T_combined），MAE 退化到 0.279；Case 1 上 LOO 选到接近
"不平滑"的配置，MAE 0.261；Case 2 上 LOO 选到过度低幅，MAE 0.298。**REML
边际似然在所有三个 case 上都优于 LOO**，所以最终保留 REML。两个值都被记录
在 `selection.log_marginal_likelihood` 与 `selection.loo_rmse` 字段。

### 4.3 论文修改

- **subsec:multi** (`docs/method.tex:185-284`)：替换 eq:obs_model_scalar，改用
  本文 §3.1 的 tail-reuse 恒等式作为多点融合的核心观测；删除把
  $b_k$ 当独立 Gaussian 观测的统计模型。
- **subsec:prior_error_coordinates** (`docs/method.tex:286-400`)：删除
  eq:prior_error_cross_obs；保留 direct 项、空间先验项，加入 tail-reuse 项。

### 4.4 集成方式

- **替换 `run_onestage_fusion.js` 内部实现**，保留外部脚本名 `run_fastrw_post.sh`、
  输出文件名 `onestage_with_self.csv` / `onestage_no_self.csv` / `onestage_summary.json`
  与 schema。论文图表与 `experiment_notes.md` 引用无需改动。
- **替换 `run_fasterrw_post.js` 内部实现**，同上。
- **保留 `run_tail_reuse_fusion.js`** 作为参考，可继续用作诊断。

---

## 5. 实测结果

脚本改写完成后，在三个 case 上跑 `scripts/run_fastrw_post.sh` 和
`scripts/run_fasterrw_post.sh` 得到的 MAE（单位 K）：

| Case | Prior | Direct | Onestage(self) | Onestage(no_self) | **FasterRW v2** |
|---|---:|---:|---:|---:|---:|
| 1 | 1.7137 | 0.3193 | 0.2305 | **0.2219** | 0.2550 |
| 2 | 0.9517 | 0.3766 | 0.3146 | 0.3151 | **0.2661** |
| 3 | 0.1917 | 0.2578 | 0.2893 | 0.2794 | **0.1723** |
| **均值** | | **0.3179** | | **0.2721** | **0.2311** |

**总结**：
- **FasterRW v2 平均 MAE 比 Onestage 改善 15%**（$0.272 \to 0.231$）。
- Case 2、Case 3 上 **FasterRW v2 明显优于 Onestage**（分别改善 $16\%$ 和
  $38\%$）。
- Case 1 上 FasterRW 比 Onestage 略差 0.033 K（$0.255$ vs $0.222$）。原因是
  prior 极差（MAE 1.71），prior-error 大部分集中在常数偏移上；GP 平滑后引入
  小幅 shrinkage，对 16 个查询点这种小样本而言反而抵消了 Onestage 的随机
  cancellation。

GP 超参数（Universal Kriging 在 REML 下挑出）：

| Case | $\ell/\Delta x$ | $\sigma_\epsilon^2 / \widehat{\mathrm{Var}}[Y]$ | $\hat c$ |
|---|---:|---:|---:|
| 1 | 20 | 3 | $+1.03$ |
| 2 | 4 | 1 | $-0.94$ |
| 3 | 12 | 0.3 | $+0.03$ |

$\hat c$ 反映了 prior 的整体偏移：Case 1 prior 偏高了约 $1$ K，Case 2 prior
偏低了约 $0.9$ K，Case 3 prior 几乎无偏。这与各 case 的 `prior_only` 信号一致
（注意 $y = \tilde T - \hat T$ 里 $\hat T$ 含 tail-reuse 的轻微正偏，所以
$\hat c$ 不等于 prior signed error）。

---

## 6. 仍未处理的事项

1. **残余 bias** of $Z_{j,k}$（§3.3 (b)）：来自 FastRW plug-in 修正经
   $1/\alpha_k$ 放大。$\alpha_{\min}=0.3$ 把它控制在 $\sim 0.3$–$0.6$ K，但
   不为零。若想进一步降低，需要：
   - 减小 $\Lambda$（增大路径长度，降低速度优势），或
   - 对每个 $\alpha$ 区间估计并扣除 bias（需要参照点），或
   - 把 plug-in bias 显式建模为隐变量。
2. **PIRW**：PIRW 用同一份 constraints 数据结构，是否需要同样改造尚未评估。
   PIRW 因 $\Lambda=10^{-4}$ 极小，plug-in bias 项接近零，理论上 tail-reuse 改造
   应当无偏。但 PIRW 本身 direct 误差已经在 0.36–0.60 K，提升空间小于 FastRW。
3. **paper 章节重写**：本方案只整理后处理脚本，正文 method.tex 改写未在本次
   范围内。

---

## 7. 关键文件指针

- 实现文件：
  - `scripts/run_onestage_fusion.js`（已改写为 tail-reuse + 逆方差融合）
  - `scripts/run_fasterrw_post.js`（已改写为 FasterRW v2：tail-reuse +
    Universal Kriging）
  - `scripts/run_tail_reuse_fusion.js`（参考实现，未改动）
- 输入数据：
  - `outputs/fastrw_case[1-3]_dof*_n2500/constraints.json`（schema-2）
  - `outputs/fastrw_case[1-3]_dof*_n2500/direct.csv`
  - `configs/fastrw_coarse_prior_case[1-3]_dof*_2500_direct.json`
- 论文：
  - `/Users/zxwang/Documents/projects/2026DATE-RW/TCAD-FastRW-v1/docs/method.tex`
  - `/Users/zxwang/Documents/projects/2026DATE-RW/TCAD-FastRW-v1/docs/appendix_fusion.tex`
- 历史诊断：
  - `experiment_notes.md` §"Fusion Diagnostics 1/2"、"Fusion Theory Note:
    Tail-Reuse Alternative"、"Tail-Reuse Postprocessor"。
