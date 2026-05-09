data {
  int<lower=1> M;                 // Number of points
  int<lower=1> N;                 // Number of direct observations per point
  int<lower=0> K;                 // Number of difference observations
  matrix[N, M] obs_data;          // Row n: n-th direct observation; column i: observation at point i

  array[K] int<lower=1, upper=M> i_k; // Indices i_k used in difference observations
  array[K] int<lower=1, upper=M> j_k; // Indices j_k used in difference observations
  vector[K] alpha_k;                  // Coefficients for each difference observation
  vector[K] b_k;                      // Observed differences
}

transformed data {
  vector<lower=0>[M] sigma_known;   // Per-point noise std estimated from direct observations
  vector<lower=0>[K] tau_known;     // Std of difference observations via error propagation
  real eps = 1e-12;                 // Numerical safeguard to avoid exact zero variance

  // Column-wise sample std: sd = sqrt(variance(col)), variance uses (N - 1) denominator
  for (i in 1:M) {
    vector[N] yi = col(obs_data, i);
    real v = variance(yi);                 // If N=1, Stan's variance is undefined; require N>=2
    sigma_known[i] = sqrt(fmax(v, eps));
  }

  // Error propagation: tau_k^2 = sigma_i^2 + (alpha_k^2) * sigma_j^2
  for (k in 1:K) {
    real si = sigma_known[i_k[k]];
    real sj = sigma_known[j_k[k]];
    tau_known[k] = sqrt( square(si) + square(alpha_k[k]) * square(sj) );
  }
}

parameters {
  vector[M] theta;           // Temperature at each point
}


model {
  theta ~ normal(70, 400);
  // Direct-observation likelihood (known noise)
  for (i in 1:M)
    col(obs_data, i) ~ normal(theta[i], sigma_known[i]);

  // Difference-observation likelihood (known noise)
  b_k ~ normal(theta[i_k] - (alpha_k .* theta[j_k]), tau_known);
}


generated quantities {
  vector[M] var_known;
  for (i in 1:M) {
    var_known[i] = sigma_known[i]*sigma_known[i];
  }
}
