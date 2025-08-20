data {
  int<lower=1> M;              // # latent variables
  int<lower=1> N;              // # obs per variable
  int<lower=1> K;              // # constraints

  // 原始 N×M 观测（只用来计算先验，不进似然）
  matrix[N, M] obs_data;

  // 约束系数
  array[K] int<lower=1,upper=M> i_k;
  array[K] int<lower=1,upper=M> j_k;
  vector[K] alpha_k;
  vector[K] b_k;

}

transformed data {
  // ── 先验均值 μ0 和对角协方差 Σ0 ─────────────────────────
  vector[M] mu0;
  vector[M] var0;
  cov_matrix[M] Sigma0;

  for (m in 1:M) {
    // 计算第 m 列的样本均值、方差
    mu0[m]  = mean( col(obs_data, m) );
    var0[m] = variance( col(obs_data, m) );
  }
  Sigma0 = diag_matrix(var0);  // 先验设为对角协方差
}

parameters {
  vector[M] X;                 // 我们要估的真正变量
}

model {
  // 1) 先验
  X ~ multi_normal(mu0, Sigma0);

  // 2) 约束观测的似然
  for (k in 1:K)
    b_k[k] ~ normal( X[i_k[k]] - alpha_k[k] * X[j_k[k]],
                     var0[i_k[k]] -  alpha_k[k] * alpha_k[k] * var0[j_k[k]] );
}


generated quantities {
  // 输出 mu0 和 var0 供结果分析使用
  // vector[M] mu0_out = mu0;
  vector[M] std0 = sqrt(var0);
}