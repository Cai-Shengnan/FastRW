import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as patches
from geomery import GeometryConfig
from matplotlib import cm

def visualize_z_cross_section(geom: GeometryConfig, save_path="z_cross_section.png"):
    fig, ax = plt.subplots(figsize=(6, 10))  # 水平尺寸变宽以适配 nx

    color_map = {
        'bottom': '#E0E0E0',
        'virtual_bottom': '#B0C4DE',
        'heat_source': '#FFCCCB',
        'virtual_top': '#B0C4DE',
        'top': '#E0E0E0'
    }

    label_map = {
        'bottom': 'Bottom',
        'virtual_bottom': 'Virtual Bottom',
        'heat_source': 'Heat Source',
        'virtual_top': 'Virtual Top',
        'top': 'Top'
    }

    region_bounds = [
        ('bottom', geom.z_bottom),
        ('virtual_bottom', geom.z_virtual1),
        ('heat_source', geom.z_heat),
        ('virtual_top', geom.z_virtual2),
        ('top', geom.z_top)
    ]

    for region, (z_start, z_end) in region_bounds:
        height = z_end - z_start + 1
        rect = patches.Rectangle(
            (0, z_start), geom.nx, height,
            facecolor=color_map[region],
            edgecolor='k',
            linewidth=0.5
        )
        ax.add_patch(rect)
        ax.text(geom.nx / 2, z_start + height / 2, label_map[region],
                ha='center', va='center', fontsize=9)

    # 吸收区 epsilon zone
    eps_top = geom.boundary_epsilon[geom.z_boundary_types['top']]
    eps_bot = geom.boundary_epsilon[geom.z_boundary_types['bottom']]
    eps_top_h = int(eps_top / geom.z_resolution)
    eps_bot_h = int(eps_bot / geom.z_resolution)

    # 顶部吸收区
    ax.add_patch(patches.Rectangle((geom.nx + 2, geom.nz_total - eps_top_h),
                                   2, eps_top_h, color='orange', label='Top ε-zone'))
    # 底部吸收区
    ax.add_patch(patches.Rectangle((geom.nx + 2, 0), 2, eps_bot_h, color='orange'))

    # 边界条件线
    bc_color = {
        'Dirichlet': 'red',
        'Neumann': 'green',
        'Robin': 'blue'
    }

    # 顶部边界线
    ax.hlines(geom.nz_total, 0, geom.nx, colors=bc_color[geom.z_boundary_types['top']],
              linestyles='--', linewidth=1.0)
    ax.text(geom.nx + 4, geom.nz_total - 1, f"{geom.z_boundary_types['top']} BC",
            color=bc_color[geom.z_boundary_types['top']], fontsize=8)

    # 底部边界线
    ax.hlines(0, 0, geom.nx, colors=bc_color[geom.z_boundary_types['bottom']],
              linestyles='--', linewidth=1.0)
    ax.text(geom.nx + 4, 1, f"{geom.z_boundary_types['bottom']} BC",
            color=bc_color[geom.z_boundary_types['bottom']], fontsize=8)

    ax.set_xlim(-1, geom.nx + 6)
    ax.set_ylim(0, geom.nz_total)
    ax.set_xlabel("X (grid index)")
    ax.set_ylabel("Z (grid index)")
    ax.set_title("Z-direction Cross Section (X-Z Plane)")

    # 图例
    handles = [patches.Patch(color=color, label=label_map[reg]) for reg, color in color_map.items()]
    handles.append(patches.Patch(color='orange', label='Absorption zone'))
    handles += [patches.Patch(color=clr, label=f"{bc} boundary") for bc, clr in bc_color.items()]
    ax.legend(handles=handles, loc='upper right', fontsize=7)

    plt.tight_layout()
    plt.savefig(save_path, dpi=300)
    plt.close()



def visualize_3d_heat_source(geom: GeometryConfig, save_path="heat_source_3d.png"):
    

    power = geom.power_density  # shape: [z, y, x]
    nz, ny, nx = power.shape

    # === Step 1: 筛选出发热区域 ===
    voxels = power > 0
    norm_power = (power - power.min()) / (power.max() - power.min() + 1e-12)
    colors = cm.hot(norm_power)  # RGBA, same shape as power

    # === Step 2: 映射到整个网格的真实位置 ===
    z_offset = geom.z_heat[0]
    full_voxels = np.zeros((geom.nz_total, geom.ny, geom.nx), dtype=bool)
    full_colors = np.zeros((geom.nz_total, geom.ny, geom.nx, 4), dtype=float)

    full_voxels[z_offset:z_offset + nz, :, :] = voxels
    full_colors[z_offset:z_offset + nz, :, :] = colors

    # === Step 3: 变换为 matplotlib 所需格式 [x, y, z] ===
    voxels_xyz = np.transpose(full_voxels, (2, 1, 0))     # [x, y, z]
    colors_xyz = np.transpose(full_colors, (2, 1, 0, 3))  # [x, y, z, RGBA]

    # === Step 4: 绘图 ===
    fig = plt.figure(figsize=(10, 8))
    ax = fig.add_subplot(111, projection='3d')
    ax.voxels(voxels_xyz, facecolors=colors_xyz, edgecolor='k', linewidth=0.05)

    # === 设置坐标轴 ===
    ax.set_xlim(0, geom.nx)
    ax.set_ylim(0, geom.ny)
    ax.set_zlim(0, geom.nz_total)

    ax.set_xlabel('X (grid index)')
    ax.set_ylabel('Y (grid index)')
    ax.set_zlabel('Z (grid index)')
    ax.set_title('3D Heat Source Distribution')

    plt.tight_layout()
    plt.savefig(save_path, dpi=300)
    plt.close()

if __name__ == "__main__":
    geom = GeometryConfig()
    visualize_z_cross_section(geom, save_path="z_cross_section.png")
    visualize_3d_heat_source(geom)

