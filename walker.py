import numpy as np
from multiprocessing import Pool, cpu_count
from tqdm import tqdm
import os
import random

class RandomWalker:
    def __init__(self, geometry_config, max_steps=8e5, eps=5e-4, delta_x=5e-7):
        """
        geometry_config: GeometryConfig 实例
        max_steps: 每条路径的最大跳跃次数
        eps: Feynman-Kac 函数 e^c(t) 的终止阈值
        delta_x: 距离边界附近的 WOS 跳跃半径 Δx，来自论文定义，默认为 5e-7
        """
        self.geom = geometry_config
        self.max_steps = max_steps
        self.eps = eps
        self.delta_x = delta_x  # WOS 跳跃半径 Δx
        
        

    def simulate_temperature(self, x0_meter, N=5000, num_workers=None):
        args = [x0_meter] * N   
        num_workers = num_workers or cpu_count()
        with Pool(num_workers) as pool:
            results = list(tqdm(pool.imap_unordered(self._simulate_single_path_wrapper, args), total=N))
            
        return np.mean(results)

    def _simulate_single_path_wrapper(self, x0_meter):
        seed = os.getpid() + int.from_bytes(os.urandom(2), 'little')  # 更强随机性
        np.random.seed(seed)
        random.seed(seed)
        return self.simulate_single_path(x0_meter)

    def simulate_single_path(self, x0_meter):
        pos = np.array(x0_meter)
        T_i = [0, 0 ,0, 0]
        e_hat = 1.0
        near_robin = 0
        hit_robin = 0
        in_robin = False # 是否处于robin边界状态
        robin_parameter = 0
        step_count = 0

        while step_count < self.max_steps and e_hat > self.eps:
            
            region = self.geom.get_region_by_coord(pos[0])  #z  neumann?
            bc_pos, bc_type, bc_param  = self.geom.is_near_boundary(pos)
            
            if bc_pos is None:
                if region in ['heat_source', 'virtual_top', 'virtual_bottom']:
                    reward = self._get_heat_reward(pos) if region == 'heat_source' else 0.0
                    T_i[0] += e_hat * reward
                    pos = self._step_wog(pos)
                else:
                    if in_robin: # 刚从 Robin边界逃离，结算robin中的情况
                        sub_T_3, e_hat= self._escape_robin(e_hat,hit_robin, near_robin, robin_parameter )
                        T_i[3] += sub_T_3
                        near_robin = 0
                        hit_robin = 0
                        in_robin = False # 是否处于robin边界状态
                        robin_parameter = 0
                        
                    pos = self._step_wos(pos)[0]
            else:  
                if bc_type == 'Dirichlet':
                    phi = bc_param
                    T_i[1] += e_hat * phi
                    break
                else:
                    if bc_pos == "top":
                        is_very_close = (pos[0] >= (self.geom.nz_total * self.geom.z_resolution - self.delta_x)) 
                    elif bc_pos == 'bottom':
                        is_very_close = (pos[0] <= self.delta_x) 
                    else:
                        raise ValueError 
                    if is_very_close:
                        step_lenth = 2 * self.delta_x
                    else:
                        step_lenth = self.delta_x
                        
                        
                    if bc_type == 'Neumann':
                        dL = self._estimate_local_time_increment(bc_type) 
                        phi = bc_param
                        T_i[2] += e_hat * phi * dL
                        pos = self._step_wos(pos, step_lenth)[0]

                    elif bc_type == 'Robin':
                        if not in_robin:
                            in_robin = True
                            robin_parameter = bc_param
                        near_robin += 1
                        pos, hit_boundary = self._step_wos(pos, step_lenth)
                        if hit_boundary:
                            hit_robin += 1
            
            
            step_count += 1
        if in_robin: # 刚从 Robin边界逃离，结算robin中的情况
            sub_T_3, e_hat= self._escape_robin(e_hat,hit_robin, near_robin, robin_parameter)
            T_i[3] += sub_T_3
        # print(T_i,e_hat)
        # print(cnt_robin)
        # print(np.sum(T_i))
        return np.sum(T_i)
    
    def _escape_robin(self, e_hat, hit_robin, near_robin, robin_parameter):
        
        sub_T_3 = 0
        h = robin_parameter
        k = 395
        c =  - h / k
        phi = -c * self.geom.T_am
        if hit_robin == 0:
            pass
        else:
            avg_step_per_hit = near_robin / hit_robin
            # print(avg_step_per_hit)
            for i in range(hit_robin):
                dL = self._estimate_local_time_increment('Robin') * avg_step_per_hit
                e_hat *= np.exp(c * dL)
                sub_T_3 += e_hat * phi * dL
            
        
        return sub_T_3, e_hat
        
        
        
        

    def _get_heat_reward(self, pos):
        z, y, x = pos
        iz = int(np.floor(z / self.geom.z_resolution) - self.geom.z_heat[0])
        
        iy = int(np.floor(y / self.geom.xy_resolution))
        ix = int(np.floor(x / self.geom.xy_resolution))

        if (0 <= iz < self.geom.nz_heat) and (0 <= iy <= self.geom.ny) and (0 <= ix <= self.geom.nx): 
            gt = self._get_gt((z, y, x))
            p = self.geom.power_density[iz, iy, ix]
            return p / gt if gt > 0 else 0.0
        return 0.0

    def _get_gt(self, pos):
        g_dict = self.geom.get_conductance(pos)
        return sum(g_dict.values())




    def _estimate_local_time_increment(self, bc_type):
        epsilon = self.geom.boundary_epsilon[bc_type]
        delta = self.delta_x
        return (delta ** 2) / (6 * epsilon) # 这里【24】说是3，但是文章说是6， 我们试一下
    

    def _step_wos(self, pos, radius = None):
        """
        改进后的 WOS 步骤：
        - 若处于上/下吸收带中，根据与边界的距离调整 r = Δx 或 2Δx
        - 否则计算从当前位置到有源区边界 & XY四周边界的最小值作为最大跳跃半径
        - 若落入虚拟网格区域，吸附到网格中心
        """
        z, y, x = pos
        region = self.geom.get_region_by_coord(z)

        if region not in ["top", "bottom"]:
            import pdb; pdb.set_trace()
            raise ValueError

        # -------------------------------
        # Case 1: 无源区：以有源区边界为限构建跳跃球
        # -------------------------------
        if radius is None:
            
            if region == 'top':
                z_upper = (self.geom.z_top[1]+1) * self.geom.z_resolution
                r_z = min(z - (self.geom.z_heat[1]+1) * self.geom.z_resolution, z_upper - z)
            else:
                z_lower = self.geom.z_bottom[0] * self.geom.z_resolution
                r_z = min(self.geom.z_heat[0] * self.geom.z_resolution - z, z - z_lower)

            # XY方向边界限制
            # r_x = min(x, self.geom.x_size - x)
            # r_y = min(y, self.geom.y_size - y)

            # radius = min(r_x, r_y, r_z)
            radius = r_z
        else:
            # -------------------------------
            # Case 2: 吸收带中的 WOS 半径调整
            # -------------------------------
            # 直接用给定的输入
            pass  
            

        # -------------------------------
        # 球面上采样跳跃点
        # -------------------------------

        vec = np.random.normal(size=3)
        vec /= np.linalg.norm(vec)
        new_pos = pos + radius * vec
        
        new_pos, hit_boundary = self._reflect(new_pos)

        # 如果落入虚拟区：吸附到网格左下角
        new_region = self.geom.get_region_by_coord(new_pos[0])
        if new_region in ['virtual_top', 'virtual_bottom']:
            z_idx = int(np.floor(new_pos[0] / self.geom.z_resolution))
            y_idx = int(np.floor(new_pos[1] / self.geom.xy_resolution))
            x_idx = int(np.floor(new_pos[2] / self.geom.xy_resolution))

            z_snap = z_idx * self.geom.z_resolution
            y_snap = y_idx * self.geom.xy_resolution
            x_snap = x_idx * self.geom.xy_resolution

            return np.array([z_snap, y_snap, x_snap]), hit_boundary

        return new_pos, hit_boundary

    def _step_wog(self, pos):
        g_dict = self.geom.get_conductance(pos)
        total_g = sum(g_dict.values())

        directions = {
            '+x': np.array([0, 0, self.geom.xy_resolution]),
            '-x': np.array([0, 0, -self.geom.xy_resolution]),
            '+y': np.array([0, self.geom.xy_resolution, 0]),
            '-y': np.array([0, -self.geom.xy_resolution, 0]),
            '+z': np.array([self.geom.z_resolution, 0, 0]),
            '-z': np.array([-self.geom.z_resolution, 0, 0]),
        }

        probs = np.array([g_dict[dir] for dir in directions]) / total_g

        choice = np.random.choice(list(directions.keys()), p=probs)
        direction_vector = directions[choice]
        new_pos = pos + direction_vector

        # 若跳出 lateral 边界（XY方向），则反射
        _, y, x = new_pos
        if x < 0 or x > self.geom.x_size or y < 0 or y > self.geom.y_size:
            return self._reflect(new_pos)[0] 

        return new_pos 


    def _reflect(self, pos):
        """
        将 pos 投影回合法区域：
        - 若 x, y 超出边界，则投影回最近合法边界
        - 若 z 超界，也回退至边界
        """
        hit_boundary = False
        z, y, x = pos
        x_max = (self.geom.nx) * self.geom.xy_resolution
        y_max = (self.geom.ny) * self.geom.xy_resolution
        z_max = (self.geom.nz_total) * self.geom.z_resolution

        # x = min(max(x, 0), x_max)
        # y = min(max(y, 0), y_max)
        
 
        if z < 0 or z > z_max:
            hit_boundary = True
        
        z = min(max(z, 0), z_max)
        
        x = -x if x < 0 else x
        x = x if x < x_max else 2 * x_max - x
        
     
        y = -y if y < 0 else y
        y = y if y < y_max else 2 * y_max - y

        # if x == x_max:
        #     x -= 1e-8
        # if y == y_max:
        #     y -= 1e-8
        return np.array([z, y, x]), hit_boundary


