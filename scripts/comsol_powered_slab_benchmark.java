import com.comsol.model.Model;
import com.comsol.model.util.ModelUtil;

import java.io.BufferedWriter;
import java.io.DataOutputStream;
import java.io.FileOutputStream;
import java.io.FileWriter;
import java.io.IOException;
import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

public class comsol_powered_slab_benchmark {
  private static final String DEFAULT_OUT_REL = "outputs/comsol_powered_slab_benchmark";
  private static final String DEFAULT_REPO_ROOT = "/Users/zxwang/Documents/codes/ResRW";
  private static final String BUILD_OUTPUT_DIR = "";
  private static final boolean BUILD_SKIP_SOLVE = false;
  private static final boolean BUILD_SMOKE_MODE = true;

  private static final double LX = 1.0e-3;
  private static final double LY = 1.0e-3;
  private static final double DX = 5.0e-4;
  private static final double DZ = 5.0e-5;
  private static final double T_BOTTOM = 5.0e-4;
  private static final double T_TOP = 5.0e-4;
  private static final double K_SOURCE = 125.0;
  private static final double K_MEDIUM = 395.0;
  private static final double T_AMBIENT = 293.15;
  private static final double QUERY_X = 0.5 * DX;
  private static final double QUERY_Y = 0.5 * DX;
  private static final String[] CASE_IDS = new String[]{
      "q1_h4900_t100um",
      "q2_h4900_t100um",
      "q1_h9800_t100um",
      "q1_h4900_t200um"
  };
  private static final double[] CASE_Q_VOL = new double[]{1.0e9, 2.0e9, 1.0e9, 1.0e9};
  private static final double[] CASE_H_TOP = new double[]{4900.0, 4900.0, 9800.0, 4900.0};
  private static final double[] CASE_H_BOTTOM = new double[]{4900.0, 4900.0, 9800.0, 4900.0};
  private static final double[] CASE_T_HEAT = new double[]{1.0e-4, 1.0e-4, 1.0e-4, 2.0e-4};

  public static void main(String[] args) {
    run();
  }

  public static Model run() {
    Path outputDirForErrors = null;
    try {
      Path repoRoot = repoRoot();
      Path outputDir = outputDir(repoRoot);
      outputDirForErrors = outputDir;
      Files.createDirectories(outputDir);
      Files.createDirectories(outputDir.resolve("rw_data"));
      Files.createDirectories(outputDir.resolve("rw_configs"));
      Files.createDirectories(outputDir.resolve("comsol_models"));

      int[] cases = cases();
      writeCaseManifest(cases, outputDir);
      writeNotes(cases, outputDir, BUILD_SKIP_SOLVE ? "prepare-only" : "prepared");

      BufferedWriter summary = Files.newBufferedWriter(outputDir.resolve("benchmark_summary.csv"));
      BufferedWriter tail = Files.newBufferedWriter(outputDir.resolve("heat_layer_tail_bins.csv"));
      try {
        summary.write("case_id,h_top_W_m2K,h_bottom_W_m2K,q_vol_W_m3,t_heat_m,total_power_W,query_x_m,query_y_m,query_z_m,analytic_T_K,comsol_T_K,comsol_minus_analytic_K,RW_Normal_Mean,component_T0_heat,component_T1_tail_or_dirichlet,component_T3_robin,RW_status\n");
        tail.write("case_id,ix,iy,iz,x_m,y_m,z_m,analytic_T_K,comsol_T_K,comsol_minus_analytic_K,cell_power_W\n");

        Model last = null;
        for (int i = 0; i < cases.length; i++) {
          int ci = cases[i];
          writeRwInputs(ci, outputDir);
          writeRwConfigs(ci, outputDir);
          Model model = buildModel(ci, outputDir);
          last = model;
          if (BUILD_SKIP_SOLVE) {
            model.save(outputDir.resolve("comsol_models").resolve(caseId(ci) + "_prepare_only.mph").toString());
            writeSummaryRow(summary, ci, Double.NaN, "not_run");
            writeTailRows(tail, ci, null);
          } else {
            model.component("comp1").mesh("mesh1").run();
            model.study("std1").run();
            double comsolQuery = interpolateOne(model, QUERY_X, QUERY_Y, queryZ(ci), outputDir, caseId(ci) + "_query");
            writeSummaryRow(summary, ci, comsolQuery, "");
            writeTailRows(tail, ci, interpolate(model, heatCellCenters(ci), outputDir, caseId(ci) + "_heat_layer"));
            model.save(outputDir.resolve("comsol_models").resolve(caseId(ci) + ".mph").toString());
          }
        }
        writeNotes(cases, outputDir, BUILD_SKIP_SOLVE ? "prepare-only; solver not run" : "solved");
        return last;
      } finally {
        try {
          summary.close();
        } finally {
          tail.close();
        }
      }
    } catch (Exception ex) {
      writeFailure(outputDirForErrors, ex);
      throw new RuntimeException("COMSOL powered slab benchmark failed", ex);
    }
  }

  private static int[] cases() {
    if (BUILD_SMOKE_MODE) return new int[]{0, 1, 2};
    return new int[]{0, 1, 2, 3};
  }

  private static Model buildModel(int ci, Path outputDir) {
    String tag = "Model_" + caseId(ci);
    Model model = ModelUtil.create(tag);
    model.modelPath(outputDir.toString());
    model.label(caseId(ci) + ".mph");

    model.param().set("Lx", meters(LX));
    model.param().set("Ly", meters(LY));
    model.param().set("t_bottom", meters(T_BOTTOM));
    model.param().set("t_heat", meters(tHeat(ci)));
    model.param().set("t_top", meters(T_TOP));
    model.param().set("z_heat0", meters(T_BOTTOM));
    model.param().set("z_heat1", meters(T_BOTTOM + tHeat(ci)));
    model.param().set("z_total", meters(totalThickness(ci)));
    model.param().set("k_source", K_SOURCE + "[W/(m*K)]");
    model.param().set("k_medium", K_MEDIUM + "[W/(m*K)]");
    model.param().set("h_top", hTop(ci) + "[W/(m^2*K)]");
    model.param().set("h_bottom", hBottom(ci) + "[W/(m^2*K)]");
    model.param().set("T_amb", T_AMBIENT + "[K]");
    model.param().set("q_vol", qVol(ci) + "[W/m^3]");

    model.component().create("comp1", true);
    model.component("comp1").geom().create("geom1", 3);
    model.component("comp1").geom("geom1").lengthUnit("m");

    createBlock(model, "blk_bottom", "Bottom medium", "0", "t_bottom");
    createBlock(model, "blk_heat", "Powered heat layer", "t_bottom", "t_heat");
    createBlock(model, "blk_top", "Top medium", "t_bottom+t_heat", "t_top");
    model.component("comp1").geom("geom1").run();

    createSelections(model, ci);
    createMaterials(model);
    createPhysics(model);
    createMesh(model);
    createStudy(model);
    return model;
  }

  private static void createBlock(Model model, String tag, String label, String zPos, String zSize) {
    model.component("comp1").geom("geom1").create(tag, "Block");
    model.component("comp1").geom("geom1").feature(tag).label(label);
    model.component("comp1").geom("geom1").feature(tag).set("size", new String[]{"Lx", "Ly", zSize});
    model.component("comp1").geom("geom1").feature(tag).set("pos", new String[]{"0", "0", zPos});
  }

  private static void createSelections(Model model, int ci) {
    double eps = 1.0e-9;
    double zHeat0 = T_BOTTOM;
    double zHeat1 = T_BOTTOM + tHeat(ci);
    double zTotal = totalThickness(ci);

    createBoxSelection(model, "sel_bottom_dom", "Bottom domain", 3, -eps, LX + eps, -eps, LY + eps, -eps, zHeat0 - eps);
    createBoxSelection(model, "sel_heat_dom", "Heat-source domain", 3, -eps, LX + eps, -eps, LY + eps, zHeat0 - eps, zHeat1 + eps);
    createBoxSelection(model, "sel_top_dom", "Top domain", 3, -eps, LX + eps, -eps, LY + eps, zHeat1 + eps, zTotal + eps);

    model.component("comp1").selection().create("sel_medium_dom", "Union");
    model.component("comp1").selection("sel_medium_dom").label("Top plus bottom medium domains");
    model.component("comp1").selection("sel_medium_dom").set("entitydim", "3");
    model.component("comp1").selection("sel_medium_dom").set("input", new String[]{"sel_bottom_dom", "sel_top_dom"});

    createBoxSelection(model, "sel_top_bnd", "Top Robin boundary", 2, -eps, LX + eps, -eps, LY + eps, zTotal - eps, zTotal + eps);
    createBoxSelection(model, "sel_bottom_bnd", "Bottom Robin boundary", 2, -eps, LX + eps, -eps, LY + eps, -eps, eps);
    createBoxSelection(model, "sel_xmin_bnd", "x=0 lateral insulation", 2, -eps, eps, -eps, LY + eps, -eps, zTotal + eps);
    createBoxSelection(model, "sel_xmax_bnd", "x=Lx lateral insulation", 2, LX - eps, LX + eps, -eps, LY + eps, -eps, zTotal + eps);
    createBoxSelection(model, "sel_ymin_bnd", "y=0 lateral insulation", 2, -eps, LX + eps, -eps, eps, -eps, zTotal + eps);
    createBoxSelection(model, "sel_ymax_bnd", "y=Ly lateral insulation", 2, -eps, LX + eps, LY - eps, LY + eps, -eps, zTotal + eps);

    model.component("comp1").selection().create("sel_lateral_bnd", "Union");
    model.component("comp1").selection("sel_lateral_bnd").label("All lateral insulation boundaries");
    model.component("comp1").selection("sel_lateral_bnd").set("entitydim", "2");
    model.component("comp1").selection("sel_lateral_bnd").set("input", new String[]{"sel_xmin_bnd", "sel_xmax_bnd", "sel_ymin_bnd", "sel_ymax_bnd"});
  }

  private static void createBoxSelection(Model model, String tag, String label, int entityDim, double xmin, double xmax, double ymin, double ymax, double zmin, double zmax) {
    model.component("comp1").selection().create(tag, "Box");
    model.component("comp1").selection(tag).label(label);
    model.component("comp1").selection(tag).geom("geom1", entityDim);
    model.component("comp1").selection(tag).set("entitydim", Integer.toString(entityDim));
    model.component("comp1").selection(tag).set("condition", "inside");
    model.component("comp1").selection(tag).set("xmin", Double.toString(xmin));
    model.component("comp1").selection(tag).set("xmax", Double.toString(xmax));
    model.component("comp1").selection(tag).set("ymin", Double.toString(ymin));
    model.component("comp1").selection(tag).set("ymax", Double.toString(ymax));
    model.component("comp1").selection(tag).set("zmin", Double.toString(zmin));
    model.component("comp1").selection(tag).set("zmax", Double.toString(zmax));
  }

  private static void createMaterials(Model model) {
    model.component("comp1").material().create("mat_medium", "Common");
    model.component("comp1").material("mat_medium").label("Medium");
    model.component("comp1").material("mat_medium").selection().named("sel_medium_dom");
    model.component("comp1").material("mat_medium").propertyGroup("def").set("thermalconductivity", new String[]{"k_medium"});
    model.component("comp1").material("mat_medium").propertyGroup("def").set("density", "1[kg/m^3]");
    model.component("comp1").material("mat_medium").propertyGroup("def").set("heatcapacity", "1[J/(kg*K)]");

    model.component("comp1").material().create("mat_source", "Common");
    model.component("comp1").material("mat_source").label("Heat source layer");
    model.component("comp1").material("mat_source").selection().named("sel_heat_dom");
    model.component("comp1").material("mat_source").propertyGroup("def").set("thermalconductivity", new String[]{"k_source"});
    model.component("comp1").material("mat_source").propertyGroup("def").set("density", "1[kg/m^3]");
    model.component("comp1").material("mat_source").propertyGroup("def").set("heatcapacity", "1[J/(kg*K)]");
  }

  private static void createPhysics(Model model) {
    model.component("comp1").physics().create("ht", "HeatTransfer", "geom1");
    model.component("comp1").physics("ht").feature("init1").set("Tinit", "T_amb");
    model.component("comp1").physics("ht").feature("solid1").set("k_mat", "userdef");
    model.component("comp1").physics("ht").feature("solid1").set("k",
        "if((z>=z_heat0)&&(z<=z_heat1),k_source,k_medium)");
    model.component("comp1").physics("ht").create("hs_uniform", "HeatSource", 3);
    model.component("comp1").physics("ht").feature("hs_uniform").selection().named("sel_heat_dom");
    model.component("comp1").physics("ht").feature("hs_uniform").set("heatSourceType", "GeneralSource");
    model.component("comp1").physics("ht").feature("hs_uniform").set("Q0", "q_vol");

    model.component("comp1").physics("ht").create("hf_top", "HeatFluxBoundary", 2);
    model.component("comp1").physics("ht").feature("hf_top").selection().named("sel_top_bnd");
    model.component("comp1").physics("ht").feature("hf_top").set("HeatFluxType", "ConvectiveHeatFlux");
    model.component("comp1").physics("ht").feature("hf_top").set("HeatTransferCoefficientType", "UserDef");
    model.component("comp1").physics("ht").feature("hf_top").set("h", "h_top");
    model.component("comp1").physics("ht").feature("hf_top").set("Text", "T_amb");

    model.component("comp1").physics("ht").create("hf_bottom", "HeatFluxBoundary", 2);
    model.component("comp1").physics("ht").feature("hf_bottom").selection().named("sel_bottom_bnd");
    model.component("comp1").physics("ht").feature("hf_bottom").set("HeatFluxType", "ConvectiveHeatFlux");
    model.component("comp1").physics("ht").feature("hf_bottom").set("HeatTransferCoefficientType", "UserDef");
    model.component("comp1").physics("ht").feature("hf_bottom").set("h", "h_bottom");
    model.component("comp1").physics("ht").feature("hf_bottom").set("Text", "T_amb");

    model.component("comp1").physics("ht").create("ins_lateral", "ThermalInsulation", 2);
    model.component("comp1").physics("ht").feature("ins_lateral").selection().named("sel_lateral_bnd");
  }

  private static void createMesh(Model model) {
    model.component("comp1").mesh().create("mesh1");
    model.component("comp1").mesh("mesh1").feature("size").set("custom", "on");
    if (BUILD_SMOKE_MODE) {
      model.component("comp1").mesh("mesh1").feature("size").set("hmax", "2.5e-4[m]");
      model.component("comp1").mesh("mesh1").feature("size").set("hmin", "5.0e-5[m]");
      model.component("comp1").mesh("mesh1").feature("size").set("hgrad", "1.5");
    } else {
      model.component("comp1").mesh("mesh1").feature("size").set("hmax", "1.0e-4[m]");
      model.component("comp1").mesh("mesh1").feature("size").set("hmin", "2.0e-5[m]");
      model.component("comp1").mesh("mesh1").feature("size").set("hgrad", "1.2");
    }
    model.component("comp1").mesh("mesh1").create("ftet1", "FreeTet");
  }

  private static void createStudy(Model model) {
    model.study().create("std1");
    model.study("std1").create("stat", "Stationary");
  }

  private static void writeSummaryRow(BufferedWriter out, int ci, double comsolT, String rwStatus) throws IOException {
    double analytic = analyticT(ci, queryZ(ci));
    out.write(String.format(Locale.US,
        "%s,%.17g,%.17g,%.17g,%.17g,%.17g,%.17g,%.17g,%.17g,%.17g,%s,%s,,,,,%s%n",
        caseId(ci), hTop(ci), hBottom(ci), qVol(ci), tHeat(ci), totalPower(ci), QUERY_X, QUERY_Y, queryZ(ci), analytic,
        finiteOrBlank(comsolT), finiteOrBlank(comsolT - analytic), rwStatus));
  }

  private static void writeTailRows(BufferedWriter out, int ci, double[] comsol) throws IOException {
    int nx = checkedRound(LX / DX, "nx");
    int ny = checkedRound(LY / DX, "ny");
    int nz = nzHeat(ci);
    int row = 0;
    for (int iz = 0; iz < nz; iz++) {
      double z = T_BOTTOM + (iz + 0.5) * DZ;
      for (int iy = 0; iy < ny; iy++) {
        double y = (iy + 0.5) * DX;
        for (int ix = 0; ix < nx; ix++) {
          double x = (ix + 0.5) * DX;
          double analytic = analyticT(ci, z);
          double comsolT = comsol == null ? Double.NaN : comsol[row];
          out.write(String.format(Locale.US, "%s,%d,%d,%d,%.17g,%.17g,%.17g,%.17g,%s,%s,%.17g%n",
              caseId(ci), ix, iy, iz, x, y, z, analytic, finiteOrBlank(comsolT), finiteOrBlank(comsolT - analytic), cellPower(ci)));
          row++;
        }
      }
    }
  }

  private static double interpolateOne(Model model, double x, double y, double z, Path outputDir, String label) throws IOException {
    List<double[]> p = new ArrayList<double[]>();
    p.add(new double[]{x, y, z});
    return interpolate(model, p, outputDir, label)[0];
  }

  private static double[] interpolate(Model model, List<double[]> points, Path outputDir, String label) throws IOException {
    double[][] coords = new double[3][points.size()];
    for (int i = 0; i < points.size(); i++) {
      coords[0][i] = points.get(i)[0];
      coords[1][i] = points.get(i)[1];
      coords[2][i] = points.get(i)[2];
    }
    String tag = "interp_" + Math.abs(label.hashCode()) + "_" + System.nanoTime();
    model.result().numerical().create(tag, "Interp");
    try {
      model.result().numerical(tag).set("data", "dset1");
      model.result().numerical(tag).set("expr", new String[]{"T"});
      model.result().numerical(tag).set("unit", new String[]{"K"});
      model.result().numerical(tag).set("edim", "3");
      model.result().numerical(tag).selection().geom("geom1", 3);
      model.result().numerical(tag).selection().all();
      model.result().numerical(tag).setInterpolationCoordinates(coords);
      model.result().numerical(tag).run();
      double[][][] data = model.result().numerical(tag).getData();
      double[][] real = model.result().numerical(tag).getReal(false);
      double[] values = new double[points.size()];
      if (data.length > 0 && data[0].length > 0 && data[0][0].length == points.size()) {
        values = data[0][0];
      } else if (real.length > 0 && real[0].length == points.size()) {
        for (int i = 0; i < points.size(); i++) values[i] = real[0][i];
      } else {
        throw new IllegalStateException("Unexpected interpolation shape for " + label);
      }
      return values;
    } finally {
      model.result().numerical().remove(tag);
    }
  }

  private static List<double[]> heatCellCenters(int ci) {
    List<double[]> points = new ArrayList<double[]>();
    int nx = checkedRound(LX / DX, "nx");
    int ny = checkedRound(LY / DX, "ny");
    for (int iz = 0; iz < nzHeat(ci); iz++) {
      double z = T_BOTTOM + (iz + 0.5) * DZ;
      for (int iy = 0; iy < ny; iy++) {
        double y = (iy + 0.5) * DX;
        for (int ix = 0; ix < nx; ix++) {
          double x = (ix + 0.5) * DX;
          points.add(new double[]{x, y, z});
        }
      }
    }
    return points;
  }

  private static void writeRwInputs(int ci, Path outputDir) throws IOException {
    Path dataDir = outputDir.resolve("rw_data").resolve(caseId(ci));
    Files.createDirectories(dataDir);
    BufferedWriter csv = Files.newBufferedWriter(dataDir.resolve("analytic_heat_layer_cells.csv"));
    DataOutputStream power = new DataOutputStream(new FileOutputStream(dataDir.resolve("power_cell_W.bin").toFile()));
    DataOutputStream temp = new DataOutputStream(new FileOutputStream(dataDir.resolve("analytic_temperature_K.bin").toFile()));
    try {
      csv.write("ix,iy,iz,x_m,y_m,z_m,cell_power_W,analytic_T_K\n");
      int nx = checkedRound(LX / DX, "nx");
      int ny = checkedRound(LY / DX, "ny");
      for (int iz = 0; iz < nzHeat(ci); iz++) {
        double z = T_BOTTOM + (iz + 0.5) * DZ;
        for (int iy = 0; iy < ny; iy++) {
          double y = (iy + 0.5) * DX;
          for (int ix = 0; ix < nx; ix++) {
            double x = (ix + 0.5) * DX;
            double t = analyticT(ci, z);
            writeLittleEndianDouble(power, cellPower(ci));
            writeLittleEndianDouble(temp, t);
            csv.write(String.format(Locale.US, "%d,%d,%d,%.17g,%.17g,%.17g,%.17g,%.17g%n", ix, iy, iz, x, y, z, cellPower(ci), t));
          }
        }
      }
    } finally {
      try {
        csv.close();
      } finally {
        try {
          power.close();
        } finally {
          temp.close();
        }
      }
    }
  }

  private static void writeRwConfigs(int ci, Path outputDir) throws IOException {
    String[] modes = new String[]{"current", "event", "hit"};
    for (int i = 0; i < modes.length; i++) {
      String mode = modes[i];
      Path runDir = outputDir.resolve("rw_runs").resolve(caseId(ci)).resolve(mode);
      Path config = outputDir.resolve("rw_configs").resolve(caseId(ci) + "_" + mode + ".json");
      Files.createDirectories(config.getParent());
      BufferedWriter out = Files.newBufferedWriter(config);
      try {
        out.write("{\n");
        out.write("  \"case_name\": \"powered_slab_" + caseId(ci) + "_" + mode + "\",\n");
        out.write("  \"power_map\": \"uniform_powered_slab\",\n");
        out.write("  \"geometry\": {\n");
        out.write(String.format(Locale.US, "    \"x_size\": %.17g,%n", LX));
        out.write(String.format(Locale.US, "    \"y_size\": %.17g,%n", LY));
        out.write(String.format(Locale.US, "    \"top_thickness\": %.17g,%n", T_TOP));
        out.write(String.format(Locale.US, "    \"middle_thickness\": %.17g,%n", tHeat(ci)));
        out.write(String.format(Locale.US, "    \"bottom_thickness\": %.17g,%n", T_BOTTOM));
        out.write(String.format(Locale.US, "    \"xy_resolution\": %.17g,%n", DX));
        out.write(String.format(Locale.US, "    \"z_resolution\": %.17g,%n", DZ));
        out.write(String.format(Locale.US, "    \"ambient_temperature\": %.17g,%n", T_AMBIENT));
        out.write(String.format(Locale.US, "    \"source_conductivity\": %.17g,%n", K_SOURCE));
        out.write(String.format(Locale.US, "    \"medium_conductivity\": %.17g%n", K_MEDIUM));
        out.write("  },\n");
        out.write("  \"boundary\": {\n");
        out.write(String.format(Locale.US, "    \"top\": { \"type\": \"Robin\", \"param\": %.17g },%n", hTop(ci)));
        out.write(String.format(Locale.US, "    \"bottom\": { \"type\": \"Robin\", \"param\": %.17g },%n", hBottom(ci)));
        out.write("    \"lateral\": { \"type\": \"Neumann\", \"param\": 0.0 },\n");
        out.write("    \"epsilon\": { \"dirichlet\": 1e-8, \"neumann\": 7.5e-7, \"robin\": 7.5e-7 }\n");
        out.write("  },\n");
        out.write("  \"data\": {\n");
        out.write("    \"power_density_path\": \"" + slash(outputDir.resolve("rw_data").resolve(caseId(ci)).resolve("power_cell_W.bin")) + "\",\n");
        out.write("    \"ground_truth_path\": \"" + slash(outputDir.resolve("rw_data").resolve(caseId(ci)).resolve("analytic_temperature_K.bin")) + "\",\n");
        out.write("    \"temperature_offset\": 0.0\n");
        out.write("  },\n");
        out.write("  \"walker\": {\n");
        out.write("    \"max_steps\": 2e7,\n");
        out.write("    \"cutoff_weight\": 0.3,\n");
        out.write("    \"delta_x\": 5e-7,\n");
        out.write("    \"use_tail_correction\": true,\n");
        out.write("    \"tail_mode\": \"gt\",\n");
        out.write("    \"robin_local_time_mode\": \"" + mode + "\",\n");
        out.write("    \"diagnostics\": { \"enabled\": true }\n");
        out.write("  },\n");
        out.write("  \"query_grid\": {\n");
        out.write("    \"x_indices\": [0],\n");
        out.write("    \"y_indices\": [0],\n");
        out.write(String.format(Locale.US, "    \"x_offset\": %.17g,%n", 0.5 * DX));
        out.write(String.format(Locale.US, "    \"y_offset\": %.17g,%n", 0.5 * DX));
        out.write(String.format(Locale.US, "    \"z\": %.17g%n", queryZ(ci)));
        out.write("  },\n");
        out.write("  \"run\": { \"num_samples\": 200, \"num_workers\": 1, \"seed\": 20260509 },\n");
        out.write("  \"output\": {\n");
        out.write("    \"directory\": \"" + slash(runDir) + "\",\n");
        out.write("    \"csv\": \"FastRw.csv\",\n");
        out.write("    \"constraints\": \"data.json\",\n");
        out.write("    \"diagnostics\": \"diagnostics.json\"\n");
        out.write("  }\n");
        out.write("}\n");
      } finally {
        out.close();
      }
    }
  }

  private static void writeCaseManifest(int[] cases, Path outputDir) throws IOException {
    BufferedWriter out = Files.newBufferedWriter(outputDir.resolve("benchmark_cases.json"));
    try {
      out.write("{\n");
      out.write("  \"mode\": \"" + (BUILD_SMOKE_MODE ? "smoke" : "full") + "\",\n");
      out.write("  \"geometry\": {\n");
      out.write(String.format(Locale.US, "    \"Lx_m\": %.17g, \"Ly_m\": %.17g, \"dx_m\": %.17g, \"dz_m\": %.17g,%n", LX, LY, DX, DZ));
      out.write(String.format(Locale.US, "    \"bottom_m\": %.17g, \"top_m\": %.17g, \"k_source_W_mK\": %.17g, \"k_medium_W_mK\": %.17g,%n", T_BOTTOM, T_TOP, K_SOURCE, K_MEDIUM));
      out.write(String.format(Locale.US, "    \"ambient_K\": %.17g%n", T_AMBIENT));
      out.write("  },\n");
      out.write("  \"cases\": [\n");
      for (int i = 0; i < cases.length; i++) {
        int ci = cases[i];
        out.write(String.format(Locale.US,
            "    {\"id\":\"%s\",\"q_vol_W_m3\":%.17g,\"h_top_W_m2K\":%.17g,\"h_bottom_W_m2K\":%.17g,\"t_heat_m\":%.17g,\"query_z_m\":%.17g,\"analytic_query_T_K\":%.17g}%s%n",
            caseId(ci), qVol(ci), hTop(ci), hBottom(ci), tHeat(ci), queryZ(ci), analyticT(ci, queryZ(ci)), i + 1 == cases.length ? "" : ","));
      }
      out.write("  ]\n");
      out.write("}\n");
    } finally {
      out.close();
    }
  }

  private static void writeNotes(int[] cases, Path outputDir, String status) throws IOException {
    BufferedWriter out = Files.newBufferedWriter(outputDir.resolve("README_powered_slab_benchmark.txt"));
    try {
      out.write("Powered slab root-cause benchmark\n");
      out.write("=================================\n\n");
      out.write("Status: " + status + "\n");
      out.write("Mode: " + (BUILD_SMOKE_MODE ? "smoke" : "full") + "\n\n");
      out.write("Design: uniform x/y heat in a centered heat layer, top/bottom Robin to the same ambient, lateral insulation.\n");
      out.write("Analytic convention uses outward conductive heat loss = h*(T_surface - T_ambient) on both z boundaries.\n");
      out.write("COMSOL uses HeatFluxBoundary/ConvectiveHeatFlux with Text=T_amb and h=h_top/h_bottom.\n\n");
      out.write("The q sweep checks heat-reward scaling. The h sweep checks Robin/local-time weighting and COMSOL Robin convention.\n");
      out.write("RW configs are generated under rw_configs; run the shell wrapper with --rw-smoke to fill combined_summary.*.\n");
      out.write("Generated RW configs use the analytic heat-layer temperature as GT tail correction; no-tail runs are a separate truncation diagnostic.\n\n");
      out.write("Primary outputs:\n");
      out.write("  benchmark_summary.csv: query-point analytic/COMSOL plus RW columns for later merge\n");
      out.write("  heat_layer_tail_bins.csv: analytic/COMSOL at every heat-layer cell center for tail-bin checks\n");
      out.write("  rw_data/*: power_cell_W.bin and analytic_temperature_K.bin inputs for RW\n");
      out.write("  rw_configs/*: generated CPU/GPU-compatible RW configs\n\n");
      out.write("Cases:\n");
      for (int i = 0; i < cases.length; i++) {
        int ci = cases[i];
        out.write(String.format(Locale.US, "  %s: q=%.6g W/m^3, h_top=%.6g, h_bottom=%.6g, t_heat=%.6g m, analytic_query=%.12g K%n",
            caseId(ci), qVol(ci), hTop(ci), hBottom(ci), tHeat(ci), analyticT(ci, queryZ(ci))));
      }
    } finally {
      out.close();
    }
  }

  private static Path outputDir(Path repoRoot) {
    if (BUILD_OUTPUT_DIR == null || BUILD_OUTPUT_DIR.trim().length() == 0) return repoRoot.resolve(DEFAULT_OUT_REL).normalize();
    Path out = Paths.get(BUILD_OUTPUT_DIR.trim());
    if (!out.isAbsolute()) out = repoRoot.resolve(out);
    return out.normalize();
  }

  private static Path repoRoot() {
    Path root = Paths.get(DEFAULT_REPO_ROOT.trim()).normalize();
    if (!root.isAbsolute()) throw new IllegalArgumentException("DEFAULT_REPO_ROOT must be absolute: " + DEFAULT_REPO_ROOT);
    return root;
  }

  private static void writeFailure(Path outputDir, Exception ex) {
    try {
      if (outputDir == null) outputDir = outputDir(repoRoot());
      Files.createDirectories(outputDir);
      PrintWriter out = new PrintWriter(new FileWriter(outputDir.resolve("java_exception.txt").toFile()));
      try {
        ex.printStackTrace(out);
      } finally {
        out.close();
      }
    } catch (Throwable ignored) {
    }
  }

  private static String meters(double value) {
    return Double.toString(value) + "[m]";
  }

  private static int checkedRound(double value, String name) {
    int rounded = (int) Math.round(value);
    if (Math.abs(value - rounded) > 1e-9) throw new IllegalArgumentException(name + " is not integral: " + value);
    return rounded;
  }

  private static String finiteOrBlank(double value) {
    if (Double.isNaN(value) || Double.isInfinite(value)) return "";
    return String.format(Locale.US, "%.17g", value);
  }

  private static String slash(Path path) {
    return path.normalize().toString().replace("\\", "/");
  }

  private static void writeLittleEndianDouble(DataOutputStream out, double value) throws IOException {
    long bits = Double.doubleToLongBits(value);
    out.writeLong(Long.reverseBytes(bits));
  }

  private static String caseId(int ci) {
    return CASE_IDS[ci];
  }

  private static double qVol(int ci) {
    return CASE_Q_VOL[ci];
  }

  private static double hTop(int ci) {
    return CASE_H_TOP[ci];
  }

  private static double hBottom(int ci) {
    return CASE_H_BOTTOM[ci];
  }

  private static double tHeat(int ci) {
    return CASE_T_HEAT[ci];
  }

  private static int nzHeat(int ci) {
    return checkedRound(tHeat(ci) / DZ, "nzHeat");
  }

  private static double totalThickness(int ci) {
    return T_BOTTOM + tHeat(ci) + T_TOP;
  }

  private static double queryZ(int ci) {
    return T_BOTTOM + 0.5 * tHeat(ci);
  }

  private static double totalPower(int ci) {
    return qVol(ci) * LX * LY * tHeat(ci);
  }

  private static double cellPower(int ci) {
    return qVol(ci) * DX * DX * DZ;
  }

  private static double analyticT(int ci, double z) {
    double a = T_BOTTOM;
    double b = T_BOTTOM + tHeat(ci);
    double heatPerArea = qVol(ci) * tHeat(ci);
    double rBottom = T_BOTTOM / K_MEDIUM;
    double rHeat = tHeat(ci) / K_SOURCE;
    double rTop = T_TOP / K_MEDIUM;
    double denom = (1.0 / hBottom(ci)) + (1.0 / hTop(ci)) + rBottom + rHeat + rTop;
    double flux0 = (-qVol(ci) * tHeat(ci) * tHeat(ci) / (2.0 * K_SOURCE) - heatPerArea * rTop - heatPerArea / hTop(ci)) / denom;
    double t0 = T_AMBIENT - flux0 / hBottom(ci);
    if (z <= a) {
      return t0 - flux0 * z / K_MEDIUM;
    }
    double ta = t0 - flux0 * T_BOTTOM / K_MEDIUM;
    if (z <= b) {
      double s = z - a;
      return ta - (flux0 * s + 0.5 * qVol(ci) * s * s) / K_SOURCE;
    }
    double tb = ta - (flux0 * tHeat(ci) + 0.5 * qVol(ci) * tHeat(ci) * tHeat(ci)) / K_SOURCE;
    return tb - (flux0 + heatPerArea) * (z - b) / K_MEDIUM;
  }
}
