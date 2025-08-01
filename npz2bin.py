import numpy as np
import matplotlib.pyplot as plt
from scipy.interpolate import interp1d
from scipy.ndimage import gaussian_filter
from scipy.interpolate import RegularGridInterpolator
import os
# Voxel sizes in meters
dz = 2e-6
dy = 2e-4
dx = 2e-4

# Load the npz file
# path = os.path.join("1-100","RR_00084")

data = np.load("1-100/RR_00084.npz")  # Replace with your actual file path
# --- Your input arrays ---
power_up = data['power'].astype(np.float128)     # shape (61, 100, 100)
power_up[5] =power_up[6]
power_up = power_up[5:55]
power_up = power_up.reshape([5,10,100,100]).sum(1) * dx * dy * dz


power_up.astype(np.float64).tofile("RR_00084_power.bin")

temp_up = data['temperature']  # shape (61, 100, 100)


temp = temp_up[5:55].reshape([5,10,100,100]).mean(1)
# temp = np.load("temp_z0.49_0.61.npy")[1:-1]
# print(temp.shape)
temp.astype(np.float64).tofile("RR_00084_temp.bin")
# import pdb;pdb.set_trace()
exit()
# print(temp_up[30,25,75],"======")

# temp_up = np.load("temp_z0.49_0.61.npy")

# print(temp_up[:,30,30])

# z_old = temp_up.shape[0]
# z_old_coords = np.linspace(0.49, 0.61, z_old)         # 旧的z轴坐标
# z_new_coords = np.linspace(0.49, 0.61, 61)            # 新的z轴坐标（长度80）
# print(z_new_coords)
# # axis=0 表示在第0维插值
# f = interp1d(z_old_coords, temp_up, axis=0, kind='nearest', fill_value="extrapolate")
# temp_up = f(z_new_coords)



pad_width = ((15, 14), (0, 0), (0, 0))
temp_up = np.pad(temp_up, pad_width=pad_width, mode="edge" )


# def smoothstep(t):
#     return 10*t**3 - 15*t**4 + 6*t**5

# smooth_N = 15
# t = np.linspace(0, 1, smooth_N)[:, None, None]

# # 前平滑
# start_val = 20  # 前常数区
# end_val = temp_up[smooth_N, :, :]
# temp_up[:smooth_N, :, :] = start_val + (end_val - start_val) * smoothstep(t)

# # 后平滑
# start_val2 = temp_up[-smooth_N-1, :, :]
# end_val2 = start_val  # 后常数区
# temp_up[-smooth_N:, :, :] = start_val2 + (end_val2 - start_val2) * smoothstep(t)

# arr = temp_up
# # 1. 高斯平滑
# sigma = 1.5  # 你可以根据需要调整
# arr_smooth = gaussian_filter(arr, sigma=sigma)

# z_coords = np.linspace(0,1,90)
# y_coords = np.linspace(0,1,100)
# x_coords = y_coords
# # 2. B样条插值拟合（RegularGridInterpolator 默认就是三维B样条）
# f_interp = RegularGridInterpolator(
#     (z_coords, y_coords, x_coords),
#     arr_smooth,
#     method='linear',  # 线性可以换成'splinef2d'（二维），更高阶B样条三维需要外部包，如 pybsplines
#     bounds_error=False,
#     fill_value=None
# )


# # 构造新的网格点（原来的z_coords, y_coords, x_coords）
# Z, Y, X = np.meshgrid(z_coords, y_coords, x_coords, indexing='ij')
# points = np.stack([Z, Y, X], axis=-1).reshape(-1, 3)   # shape: (N, 3)

# # 用插值函数在这些点上采样
# temp_up = f_interp(points).reshape(arr.shape)

# print(temp_up[45,25,75])


# --- 1. Define piecewise k(z) ---
z_coords = np.arange(90)  # shape (61,)
k_z = np.where((z_coords < 19) | (z_coords > 70), 395.0, 125.0)  # shape (61,)

# --- 2. Moving average smoothing ---
def moving_average_1d(array, window_size=5):
    """
    Smooth a 1D array using centered moving average.
    """
    if window_size % 2 == 0:
        raise ValueError("Window size must be odd for symmetric smoothing.")
    pad_size = window_size // 2
    padded = np.pad(array, pad_size, mode='edge')
    kernel = np.ones(window_size) / window_size
    smoothed = np.convolve(padded, kernel, mode='valid')
    return smoothed

# Apply moving average
k_z_smooth = moving_average_1d(k_z, window_size=1)  # Adjust window_size as needed

# --- 3. Expand to 3D ---
k = k_z_smooth[:, None, None]  # shape (61, 1, 1) → broadcast to (61, 100, 100)



def laplacian_3d_edge(u):
    """
    计算三维数组的拉普拉斯算子，使用 edge 边界处理（复制边界）
    
    参数:
        u: 3D ndarray
        dx, dy, dz: 网格间距
    返回:
        laplacian: 拉普拉斯算子结果数组
    """
    # 使用 edge 填充一层边界
    u_pad = np.pad(u, pad_width=1, mode='edge')

    # 计算中心差分（对应内部区域）
    d2u_dz2 = (u_pad[2:, 1:-1, 1:-1] - 2*u + u_pad[:-2, 1:-1, 1:-1])
    d2u_dy2 = (u_pad[1:-1, 2:, 1:-1] - 2*u + u_pad[1:-1, :-2, 1:-1])
    d2u_dx2 = (u_pad[1:-1, 1:-1, 2:] - 2*u + u_pad[1:-1, 1:-1, :-2]) 
    
    print(d2u_dz2[:,30,30])
    print(d2u_dy2[:,30,30])
    print(d2u_dx2[:,30,30])

    return d2u_dx2, d2u_dy2, d2u_dz2


d2u_dx2, d2u_dy2, d2u_dz2 = laplacian_3d_edge(temp_up) 


laplacian_temp = d2u_dx2 / dx ** 2 + d2u_dy2 / dy ** 2 + d2u_dz2 / dz ** 2


# laplacian_temp[0] = laplacian_temp[1]


# laplacian_temp[0] = laplacian_temp[1]
# laplacian_temp[-1] = laplacian_temp[-2]


# p_res = power_up  + laplacian_temp * k * 1e8
pad_width = ((15, 14), (0, 0), (0, 0))

power_up = np.pad(power_up, pad_width=pad_width, mode="constant", constant_values= 0 )
power_up[20] = power_up[21]



p_res_low = np.zeros([9,100,100])
for i in range(0,p_res_low.shape[0]):
    low = max(0, i* 10)
    high = min(power_up.shape[0], i * 10 + 10)
  

    p_res_low[i] = np.mean(power_up[low:high] ,0) + np.mean(laplacian_temp[low:high] * k[low:high] ,0)
import pdb; pdb.set_trace() 
plt.figure()
plt.subplot(2,1,1)
plt.imshow(p_res_low[4])
plt.colorbar()
plt.subplot(2,1,2)
plt.imshow(p_res_low[:,30])
plt.colorbar()
plt.show()


p_res_low = p_res_low[2:-2] * dx * dy * dz * 10
print(p_res_low.shape)
# Save p_res_low to binary format for C++ (double format)
p_res_low.astype(np.float64).tofile("RR_0000_power_res.bin")

power_up = power_up[20:-20].reshape([5,10,100,100]).sum(1)


power_up =power_up * dx * dy * dz

import pdb;pdb.set_trace()

power_up.astype(np.float64).tofile("RR_0000_power.bin")

