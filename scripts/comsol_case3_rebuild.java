import com.comsol.model.Model;
import com.comsol.model.util.ModelUtil;

import java.io.BufferedWriter;
import java.io.DataOutputStream;
import java.io.FileWriter;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.PrintWriter;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class comsol_case3_rebuild {
  private static final String CASE_NAME = "case3_16core";
  private static final String CONFIG_REL = "configs/case3_16core.json";
  private static final String DEFAULT_OUT_REL = "outputs/comsol_case3_rebuild";
  private static final String DEFAULT_REPO_ROOT = "/Users/zxwang/Documents/codes/ResRW";
  private static final String BUILD_OUTPUT_DIR = "";
  private static final boolean BUILD_SKIP_SOLVE = false;
  private static final boolean BUILD_SMOKE_MODE = false;

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

      Map cfg = readCaseConfig(repoRoot.resolve(CONFIG_REL));
      writeRunInputs(cfg, outputDir);

      Model model = buildModel(cfg, outputDir);
      writeNotes(cfg, outputDir, "prepared");

      if (BUILD_SKIP_SOLVE) {
        model.save(outputDir.resolve("case3_rebuild_prepare_only.mph").toString());
        writeNotes(cfg, outputDir, "prepare-only; solver not run");
        return model;
      }

      model.component("comp1").mesh("mesh1").run();
      model.study("std1").run();
      exportTemperatures(model, cfg, outputDir);
      model.save(outputDir.resolve("case3_rebuild.mph").toString());
      writeNotes(cfg, outputDir, "solved");
      return model;
    } catch (Exception ex) {
      writeFailure(outputDirForErrors, ex);
      throw new RuntimeException("COMSOL case3 rebuild failed", ex);
    }
  }

  private static Model buildModel(Map cfg, Path outputDir) throws IOException {
    Model model = ModelUtil.create("Model");
    model.modelPath(outputDir.toString());
    model.label("case3_16core_rebuild.mph");

    model.param().set("Lx", meters(d(cfg, "lx")));
    model.param().set("Ly", meters(d(cfg, "ly")));
    model.param().set("t_bottom", meters(d(cfg, "tBottom")));
    model.param().set("t_heat", meters(d(cfg, "tHeat")));
    model.param().set("t_top", meters(d(cfg, "tTop")));
    model.param().set("z_heat0", meters(d(cfg, "tBottom")));
    model.param().set("z_heat1", meters(d(cfg, "tBottom") + d(cfg, "tHeat")));
    model.param().set("z_total", meters(d(cfg, "tBottom") + d(cfg, "tHeat") + d(cfg, "tTop")));
    model.param().set("dx_cell", meters(d(cfg, "dx")));
    model.param().set("dy_cell", meters(d(cfg, "dx")));
    model.param().set("dz_cell", meters(d(cfg, "dz")));
    model.param().set("k_source", Double.toString(d(cfg, "kSource")) + "[W/(m*K)]");
    model.param().set("k_medium", Double.toString(d(cfg, "kMedium")) + "[W/(m*K)]");
    model.param().set("h_top", Double.toString(d(cfg, "hTop")) + "[W/(m^2*K)]");
    model.param().set("h_bottom", Double.toString(d(cfg, "hBottom")) + "[W/(m^2*K)]");
    model.param().set("T_amb", Double.toString(d(cfg, "ambient")) + "[K]");

    createHeatSourceFunction(model, cfg);

    model.component().create("comp1", true);
    model.component("comp1").geom().create("geom1", 3);
    model.component("comp1").geom("geom1").lengthUnit("m");

    model.component("comp1").geom("geom1").create("blk_bottom", "Block");
    model.component("comp1").geom("geom1").feature("blk_bottom").label("Bottom medium, 1000 um");
    model.component("comp1").geom("geom1").feature("blk_bottom").set("size", new String[]{"Lx", "Ly", "t_bottom"});
    model.component("comp1").geom("geom1").feature("blk_bottom").set("pos", new String[]{"0", "0", "0"});

    model.component("comp1").geom("geom1").create("blk_heat", "Block");
    model.component("comp1").geom("geom1").feature("blk_heat").label("Heat source layer, 100 um");
    model.component("comp1").geom("geom1").feature("blk_heat").set("size", new String[]{"Lx", "Ly", "t_heat"});
    model.component("comp1").geom("geom1").feature("blk_heat").set("pos", new String[]{"0", "0", "t_bottom"});

    model.component("comp1").geom("geom1").create("blk_top", "Block");
    model.component("comp1").geom("geom1").feature("blk_top").label("Top medium, 500 um");
    model.component("comp1").geom("geom1").feature("blk_top").set("size", new String[]{"Lx", "Ly", "t_top"});
    model.component("comp1").geom("geom1").feature("blk_top").set("pos", new String[]{"0", "0", "t_bottom+t_heat"});
    model.component("comp1").geom("geom1").run();

    createSelections(model, cfg);
    createMaterials(model);
    createPhysics(model);
    createMesh(model);
    createStudy(model);
    return model;
  }

  private static void createHeatSourceFunction(Model model, Map cfg) throws IOException {
    double[] powerCell = readPowerCells(cfg);
    double cellVolume = d(cfg, "dx") * d(cfg, "dx") * d(cfg, "dz");
    String[][] table = new String[powerCell.length][2];
    int row = 0;
    for (int iz = 0; iz < i(cfg, "nzHeat"); iz++) {
      for (int iy = 0; iy < i(cfg, "ny"); iy++) {
        for (int ix = 0; ix < i(cfg, "nx"); ix++) {
          table[row][0] = Integer.toString(row);
          table[row][1] = Double.toString(powerCell[row] / cellVolume);
          row++;
        }
      }
    }

    model.func().create("qsrc", "Interpolation");
    model.func("qsrc").label("case3 power_cell/(dx*dy*dz), 1D cell-index lookup");
    model.func("qsrc").set("funcname", "qsrc");
    model.func("qsrc").set("source", "table");
    model.func("qsrc").set("nargs", "1");
    model.func("qsrc").set("interp", "neighbor");
    model.func("qsrc").set("extrap", "value");
    model.func("qsrc").set("extrapvalue", "0");
    model.func("qsrc").set("argunit", "1");
    model.func("qsrc").set("fununit", "W/m^3");
    model.func("qsrc").set("table", table);
  }

  private static void createSelections(Model model, Map cfg) {
    double eps = Math.max(1e-12, d(cfg, "dz") * 1e-3);
    double zHeat0 = d(cfg, "tBottom");
    double zHeat1 = d(cfg, "tBottom") + d(cfg, "tHeat");
    double zTotal = d(cfg, "tBottom") + d(cfg, "tHeat") + d(cfg, "tTop");

    createBoxSelection(model, "sel_bottom_dom", "Bottom domain", 3,
        -eps, d(cfg, "lx") + eps, -eps, d(cfg, "ly") + eps, -eps, zHeat0 - eps, "inside");
    createBoxSelection(model, "sel_heat_dom", "Heat-source domain", 3,
        -eps, d(cfg, "lx") + eps, -eps, d(cfg, "ly") + eps, zHeat0 - eps, zHeat1 + eps, "inside");
    createBoxSelection(model, "sel_top_dom", "Top domain", 3,
        -eps, d(cfg, "lx") + eps, -eps, d(cfg, "ly") + eps, zHeat1 + eps, zTotal + eps, "inside");

    model.component("comp1").selection().create("sel_medium_dom", "Union");
    model.component("comp1").selection("sel_medium_dom").label("Top plus bottom medium domains");
    model.component("comp1").selection("sel_medium_dom").set("entitydim", "3");
    model.component("comp1").selection("sel_medium_dom").set("input", new String[]{"sel_bottom_dom", "sel_top_dom"});

    createBoxSelection(model, "sel_top_bnd", "Top Robin boundary", 2,
        -eps, d(cfg, "lx") + eps, -eps, d(cfg, "ly") + eps, zTotal - eps, zTotal + eps, "inside");
    createBoxSelection(model, "sel_bottom_bnd", "Bottom Robin boundary", 2,
        -eps, d(cfg, "lx") + eps, -eps, d(cfg, "ly") + eps, -eps, eps, "inside");

    createBoxSelection(model, "sel_xmin_bnd", "x=0 lateral insulation boundary", 2,
        -eps, eps, -eps, d(cfg, "ly") + eps, -eps, zTotal + eps, "inside");
    createBoxSelection(model, "sel_xmax_bnd", "x=Lx lateral insulation boundary", 2,
        d(cfg, "lx") - eps, d(cfg, "lx") + eps, -eps, d(cfg, "ly") + eps, -eps, zTotal + eps, "inside");
    createBoxSelection(model, "sel_ymin_bnd", "y=0 lateral insulation boundary", 2,
        -eps, d(cfg, "lx") + eps, -eps, eps, -eps, zTotal + eps, "inside");
    createBoxSelection(model, "sel_ymax_bnd", "y=Ly lateral insulation boundary", 2,
        -eps, d(cfg, "lx") + eps, d(cfg, "ly") - eps, d(cfg, "ly") + eps, -eps, zTotal + eps, "inside");

    model.component("comp1").selection().create("sel_lateral_bnd", "Union");
    model.component("comp1").selection("sel_lateral_bnd").label("All lateral insulation boundaries");
    model.component("comp1").selection("sel_lateral_bnd").set("entitydim", "2");
    model.component("comp1").selection("sel_lateral_bnd").set(
        "input", new String[]{"sel_xmin_bnd", "sel_xmax_bnd", "sel_ymin_bnd", "sel_ymax_bnd"});
  }

  private static void createBoxSelection(
      Model model,
      String tag,
      String label,
      int entityDim,
      double xmin,
      double xmax,
      double ymin,
      double ymax,
      double zmin,
      double zmax,
      String condition) {
    model.component("comp1").selection().create(tag, "Box");
    model.component("comp1").selection(tag).label(label);
    model.component("comp1").selection(tag).geom("geom1", entityDim);
    model.component("comp1").selection(tag).set("entitydim", Integer.toString(entityDim));
    model.component("comp1").selection(tag).set("condition", condition);
    model.component("comp1").selection(tag).set("xmin", Double.toString(xmin));
    model.component("comp1").selection(tag).set("xmax", Double.toString(xmax));
    model.component("comp1").selection(tag).set("ymin", Double.toString(ymin));
    model.component("comp1").selection(tag).set("ymax", Double.toString(ymax));
    model.component("comp1").selection(tag).set("zmin", Double.toString(zmin));
    model.component("comp1").selection(tag).set("zmax", Double.toString(zmax));
  }

  private static void createMaterials(Model model) {
    model.component("comp1").material().create("mat_medium", "Common");
    model.component("comp1").material("mat_medium").label("Medium k=395 W/(m*K)");
    model.component("comp1").material("mat_medium").selection().named("sel_medium_dom");
    model.component("comp1").material("mat_medium").propertyGroup("def").set("thermalconductivity", new String[]{"k_medium"});
    model.component("comp1").material("mat_medium").propertyGroup("def").set("density", "1[kg/m^3]");
    model.component("comp1").material("mat_medium").propertyGroup("def").set("heatcapacity", "1[J/(kg*K)]");

    model.component("comp1").material().create("mat_source", "Common");
    model.component("comp1").material("mat_source").label("Source k=125 W/(m*K)");
    model.component("comp1").material("mat_source").selection().named("sel_heat_dom");
    model.component("comp1").material("mat_source").propertyGroup("def").set("thermalconductivity", new String[]{"k_source"});
    model.component("comp1").material("mat_source").propertyGroup("def").set("density", "1[kg/m^3]");
    model.component("comp1").material("mat_source").propertyGroup("def").set("heatcapacity", "1[J/(kg*K)]");
  }

  private static void createPhysics(Model model) {
    model.component("comp1").physics().create("ht", "HeatTransfer", "geom1");
    model.component("comp1").physics("ht").label("Heat Transfer in Solids");
    model.component("comp1").physics("ht").feature("init1").set("Tinit", "T_amb");
    model.component("comp1").physics("ht").feature("solid1").set("k_mat", "userdef");
    model.component("comp1").physics("ht").feature("solid1").set("k",
        "if((z>=z_heat0)&&(z<=z_heat1),k_source,k_medium)");

    model.component("comp1").physics("ht").create("hs_case3", "HeatSource", 3);
    model.component("comp1").physics("ht").feature("hs_case3").label("100x100x5 volumetric heat source");
    model.component("comp1").physics("ht").feature("hs_case3").selection().named("sel_heat_dom");
    model.component("comp1").physics("ht").feature("hs_case3").set("heatSourceType", "GeneralSource");
    model.component("comp1").physics("ht").feature("hs_case3").set("Q0",
        "qsrc(min(max(floor(x/dx_cell),0),99)+100*min(max(floor(y/dy_cell),0),99)+10000*min(max(floor((z-z_heat0)/dz_cell),0),4))");

    model.component("comp1").physics("ht").create("hf_top", "HeatFluxBoundary", 2);
    model.component("comp1").physics("ht").feature("hf_top").label("Top Robin h=4900, Tinf=293.15 K");
    model.component("comp1").physics("ht").feature("hf_top").selection().named("sel_top_bnd");
    model.component("comp1").physics("ht").feature("hf_top").set("HeatFluxType", "ConvectiveHeatFlux");
    model.component("comp1").physics("ht").feature("hf_top").set("HeatTransferCoefficientType", "UserDef");
    model.component("comp1").physics("ht").feature("hf_top").set("h", "h_top");
    model.component("comp1").physics("ht").feature("hf_top").set("Text", "T_amb");

    model.component("comp1").physics("ht").create("hf_bottom", "HeatFluxBoundary", 2);
    model.component("comp1").physics("ht").feature("hf_bottom").label("Bottom Robin h=4900, Tinf=293.15 K");
    model.component("comp1").physics("ht").feature("hf_bottom").selection().named("sel_bottom_bnd");
    model.component("comp1").physics("ht").feature("hf_bottom").set("HeatFluxType", "ConvectiveHeatFlux");
    model.component("comp1").physics("ht").feature("hf_bottom").set("HeatTransferCoefficientType", "UserDef");
    model.component("comp1").physics("ht").feature("hf_bottom").set("h", "h_bottom");
    model.component("comp1").physics("ht").feature("hf_bottom").set("Text", "T_amb");

    model.component("comp1").physics("ht").create("ins_lateral", "ThermalInsulation", 2);
    model.component("comp1").physics("ht").feature("ins_lateral").label("Lateral Neumann zero flux");
    model.component("comp1").physics("ht").feature("ins_lateral").selection().named("sel_lateral_bnd");
  }

  private static void createMesh(Model model) {
    model.component("comp1").mesh().create("mesh1");
    model.component("comp1").mesh("mesh1").label("case3 reproducible mesh");
    model.component("comp1").mesh("mesh1").feature("size").set("custom", "on");
    if (BUILD_SMOKE_MODE) {
      model.component("comp1").mesh("mesh1").label("case3 smoke-test coarse mesh");
      model.component("comp1").mesh("mesh1").feature("size").set("hmax", "4[mm]");
      model.component("comp1").mesh("mesh1").feature("size").set("hmin", "500[um]");
      model.component("comp1").mesh("mesh1").feature("size").set("hgrad", "2.0");
      model.component("comp1").mesh("mesh1").feature("size").set("hnarrow", "1");
      model.component("comp1").mesh("mesh1").feature("size").set("hcurve", "1");
    } else {
      model.component("comp1").mesh("mesh1").feature("size").set("hmax", "dx_cell");
      model.component("comp1").mesh("mesh1").feature("size").set("hmin", "dz_cell");
      model.component("comp1").mesh("mesh1").feature("size").set("hgrad", "1.2");
      model.component("comp1").mesh("mesh1").feature("size").set("hnarrow", "0.8");
      model.component("comp1").mesh("mesh1").feature("size").set("hcurve", "0.3");
    }
    model.component("comp1").mesh("mesh1").create("ftet1", "FreeTet");
    model.component("comp1").mesh("mesh1").feature("ftet1").label(
        BUILD_SMOKE_MODE ? "Free tetrahedral smoke mesh, hmax=4 mm" : "Free tetrahedral mesh, hmax=cell dx");
  }

  private static void createStudy(Model model) {
    model.study().create("std1");
    model.study("std1").label("Stationary case3 rebuild");
    model.study("std1").create("stat", "Stationary");
  }

  private static void exportTemperatures(Model model, Map cfg, Path outputDir) throws IOException {
    List<double[]> queryPoints = queryPoints(cfg);
    double[] queryTemps = interpolate(model, queryPoints, outputDir, "query");
    BufferedWriter out = Files.newBufferedWriter(outputDir.resolve("query_temperatures.csv"));
    try {
      out.write("Point,X,Y,Z,T_K\n");
      for (int i = 0; i < queryPoints.size(); i++) {
        double[] p = queryPoints.get(i);
        out.write(String.format(Locale.US, "%d,%.17g,%.17g,%.17g,%.17g%n", i, p[0], p[1], p[2], queryTemps[i]));
      }
    } finally {
      out.close();
    }

    List<double[]> cellCenters = heatCellCenters(cfg);
    double[] cellTemps = interpolate(model, cellCenters, outputDir, "heat_layer");
    BufferedWriter tempOut = Files.newBufferedWriter(outputDir.resolve("heat_layer_cell_center_temperatures.csv"));
    DataOutputStream bin = new DataOutputStream(new FileOutputStream(outputDir.resolve("heat_layer_cell_center_temperatures.bin").toFile()));
    try {
      tempOut.write("ix,iy,iz,X,Y,Z,T_K\n");
      int row = 0;
      for (int iz = 0; iz < i(cfg, "nzHeat"); iz++) {
        for (int iy = 0; iy < i(cfg, "ny"); iy++) {
          for (int ix = 0; ix < i(cfg, "nx"); ix++) {
            double[] p = cellCenters.get(row);
            double t = cellTemps[row];
            tempOut.write(String.format(Locale.US, "%d,%d,%d,%.17g,%.17g,%.17g,%.17g%n", ix, iy, iz, p[0], p[1], p[2], t));
            writeLittleEndianDouble(bin, t);
            row++;
          }
        }
      }
    } finally {
      try {
        tempOut.close();
      } finally {
        bin.close();
      }
    }
  }

  private static double[] interpolate(Model model, List<double[]> points, Path outputDir, String label) throws IOException {
    double[][] coords = new double[3][points.size()];
    for (int i = 0; i < points.size(); i++) {
      coords[0][i] = points.get(i)[0];
      coords[1][i] = points.get(i)[1];
      coords[2][i] = points.get(i)[2];
    }
    String tag = "interp_" + System.nanoTime();
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
      double[][] outCoords = model.result().numerical(tag).getCoordinates();
      writeInterpolationDebug(outputDir, label, tag, points.size(), data, real, outCoords);
      double[] values;
      if (data.length > 0 && data[0].length > 0 && data[0][0].length == points.size()) {
        values = data[0][0];
      } else {
        values = flattenReal(real, points.size());
      }
      if (!hasFinite(values)) {
        throw new IllegalStateException("COMSOL interpolation returned no finite T values for "
            + label + " points; see interpolation_" + label + "_debug.txt");
      }
      return values;
    } finally {
      model.result().numerical().remove(tag);
    }
  }

  private static double[] flattenReal(double[][] data, int expectedLength) {
    double[] out = new double[expectedLength];
    if (data.length == expectedLength) {
      for (int i = 0; i < expectedLength; i++) out[i] = data[i].length == 0 ? Double.NaN : data[i][0];
      return out;
    }
    if (data.length > 0 && data[0].length == expectedLength) {
      for (int i = 0; i < expectedLength; i++) out[i] = data[0][i];
      return out;
    }
    int row = 0;
    int col = 0;
    for (int i = 0; i < expectedLength; i++) {
      if (row >= data.length) {
        out[i] = Double.NaN;
      } else {
        out[i] = data[row][col++];
        if (col >= data[row].length) {
          row++;
          col = 0;
        }
      }
    }
    return out;
  }

  private static boolean hasFinite(double[] values) {
    for (int i = 0; i < values.length; i++) {
      if (!Double.isNaN(values[i]) && !Double.isInfinite(values[i])) return true;
    }
    return false;
  }

  private static void writeInterpolationDebug(
      Path outputDir,
      String label,
      String tag,
      int requestedPoints,
      double[][][] data,
      double[][] real,
      double[][] coords) throws IOException {
    BufferedWriter out = Files.newBufferedWriter(outputDir.resolve("interpolation_" + label + "_debug.txt"));
    try {
      out.write("tag: " + tag + "\n");
      out.write("requested_points: " + requestedPoints + "\n");
      out.write("getData_shape: " + data.length);
      if (data.length > 0) {
        out.write(" x " + data[0].length);
        if (data[0].length > 0) out.write(" x " + data[0][0].length);
      }
      out.write("\n");
      out.write("getReal_shape: " + real.length);
      if (real.length > 0) out.write(" x " + real[0].length);
      out.write("\n");
      out.write("getCoordinates_shape: " + coords.length);
      if (coords.length > 0) out.write(" x " + coords[0].length);
      out.write("\n");
      if (data.length > 0 && data[0].length > 0 && data[0][0].length > 0) {
        out.write(String.format(Locale.US, "getData_first_value: %.17g%n", data[0][0][0]));
      }
      if (real.length > 0 && real[0].length > 0) {
        out.write(String.format(Locale.US, "getReal_first_value: %.17g%n", real[0][0]));
      }
    } finally {
      out.close();
    }
  }

  private static List<double[]> queryPoints(Map cfg) {
    List<double[]> points = new ArrayList<double[]>();
    for (int iy : ints(cfg, "yIndices")) {
      double y = d(cfg, "dx") * iy + d(cfg, "yOffset");
      for (int ix : ints(cfg, "xIndices")) {
        double x = d(cfg, "dx") * ix + d(cfg, "xOffset");
        points.add(new double[]{x, y, d(cfg, "z")});
      }
    }
    return points;
  }

  private static List<double[]> heatCellCenters(Map cfg) {
    List<double[]> points = new ArrayList<double[]>(i(cfg, "nx") * i(cfg, "ny") * i(cfg, "nzHeat"));
    for (int iz = 0; iz < i(cfg, "nzHeat"); iz++) {
      double z = d(cfg, "tBottom") + (iz + 0.5) * d(cfg, "dz");
      for (int iy = 0; iy < i(cfg, "ny"); iy++) {
        double y = (iy + 0.5) * d(cfg, "dx");
        for (int ix = 0; ix < i(cfg, "nx"); ix++) {
          double x = (ix + 0.5) * d(cfg, "dx");
          points.add(new double[]{x, y, z});
        }
      }
    }
    return points;
  }

  private static void writeRunInputs(Map cfg, Path outputDir) throws IOException {
    double[] powerCell = readPowerCells(cfg);
    double cellVolume = d(cfg, "dx") * d(cfg, "dx") * d(cfg, "dz");
    BufferedWriter out = Files.newBufferedWriter(outputDir.resolve("power_density_cell_centers.csv"));
    try {
      out.write("ix,iy,iz,X,Y,Z,power_cell_W,Q_W_per_m3\n");
      int row = 0;
      for (int iz = 0; iz < i(cfg, "nzHeat"); iz++) {
        double z = d(cfg, "tBottom") + (iz + 0.5) * d(cfg, "dz");
        for (int iy = 0; iy < i(cfg, "ny"); iy++) {
          double y = (iy + 0.5) * d(cfg, "dx");
          for (int ix = 0; ix < i(cfg, "nx"); ix++) {
            double x = (ix + 0.5) * d(cfg, "dx");
            double power = powerCell[row++];
            out.write(String.format(
                Locale.US, "%d,%d,%d,%.17g,%.17g,%.17g,%.17g,%.17g%n",
                ix, iy, iz, x, y, z, power, power / cellVolume));
          }
        }
      }
    } finally {
      out.close();
    }

    BufferedWriter queryOut = Files.newBufferedWriter(outputDir.resolve("query_points.csv"));
    try {
      queryOut.write("Point,X,Y,Z\n");
      int i = 0;
      for (double[] p : queryPoints(cfg)) {
        queryOut.write(String.format(Locale.US, "%d,%.17g,%.17g,%.17g%n", i++, p[0], p[1], p[2]));
      }
    } finally {
      queryOut.close();
    }
  }

  private static Map readCaseConfig(Path configPath) throws IOException {
    String json = new String(Files.readAllBytes(configPath), Charset.forName("UTF-8"));
    Map cfg = new HashMap();
    cfg.put("configPath", configPath.normalize());
    cfg.put("repoRoot", path(cfg, "configPath").getParent().getParent());
    cfg.put("lx", Double.valueOf(number(json, "x_size", 0.02)));
    cfg.put("ly", Double.valueOf(number(json, "y_size", 0.02)));
    cfg.put("tTop", Double.valueOf(number(json, "top_thickness", 0.0005)));
    cfg.put("tHeat", Double.valueOf(number(json, "middle_thickness", 0.0001)));
    cfg.put("tBottom", Double.valueOf(number(json, "bottom_thickness", 0.001)));
    cfg.put("dx", Double.valueOf(number(json, "xy_resolution", 0.0002)));
    cfg.put("dz", Double.valueOf(number(json, "z_resolution", 0.00002)));
    cfg.put("ambient", Double.valueOf(number(json, "ambient_temperature", 293.15)));
    cfg.put("kSource", Double.valueOf(number(json, "source_conductivity", 125.0)));
    cfg.put("kMedium", Double.valueOf(number(json, "medium_conductivity", 395.0)));
    cfg.put("hTop", Double.valueOf(boundaryParam(json, "top", 4900.0)));
    cfg.put("hBottom", Double.valueOf(boundaryParam(json, "bottom", 4900.0)));
    cfg.put("xIndices", intArray(json, "x_indices", new int[]{10, 20, 30, 40}));
    cfg.put("yIndices", intArray(json, "y_indices", new int[]{10, 20, 30, 40}));
    cfg.put("xOffset", Double.valueOf(number(json, "x_offset", 0.0)));
    cfg.put("yOffset", Double.valueOf(number(json, "y_offset", 0.0)));
    double z = hasKey(json, "z")
        ? number(json, "z", d(cfg, "tBottom") + 0.5 * d(cfg, "tHeat"))
        : d(cfg, "tBottom") + 0.5 * d(cfg, "tHeat");
    cfg.put("z", Double.valueOf(z + number(json, "z_offset", 0.0)));
    String powerRel = stringValue(json, "power_density_path", "../data/16_cores_4900/5.28M/power.bin");
    cfg.put("powerPath", path(cfg, "configPath").getParent().resolve(powerRel).normalize());
    cfg.put("nx", Integer.valueOf(checkedRound(d(cfg, "lx") / d(cfg, "dx"), "nx")));
    cfg.put("ny", Integer.valueOf(checkedRound(d(cfg, "ly") / d(cfg, "dx"), "ny")));
    cfg.put("nzHeat", Integer.valueOf(checkedRound(d(cfg, "tHeat") / d(cfg, "dz"), "nzHeat")));
    if (i(cfg, "nx") != 100 || i(cfg, "ny") != 100 || i(cfg, "nzHeat") != 5) {
      throw new IllegalArgumentException("Expected 100x100x5 heat cells from case3 config; got "
          + i(cfg, "nx") + "x" + i(cfg, "ny") + "x" + i(cfg, "nzHeat"));
    }
    return cfg;
  }

  private static double[] readPowerCells(Map cfg) throws IOException {
    int n = i(cfg, "nx") * i(cfg, "ny") * i(cfg, "nzHeat");
    byte[] bytes = Files.readAllBytes(path(cfg, "powerPath"));
    double[] values = new double[n];
    ByteBuffer bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
    if (bytes.length == n * Double.BYTES) {
      for (int i = 0; i < n; i++) values[i] = bb.getDouble();
    } else if (bytes.length == n * Float.BYTES) {
      for (int i = 0; i < n; i++) values[i] = bb.getFloat();
    } else {
      throw new IllegalArgumentException("Unexpected power file size " + bytes.length
          + "; expected " + (n * Double.BYTES) + " bytes for float64 or "
          + (n * Float.BYTES) + " bytes for float32.");
    }
    return values;
  }

  private static void writeNotes(Map cfg, Path outputDir, String status) throws IOException {
    BufferedWriter out = Files.newBufferedWriter(outputDir.resolve("model_notes.txt"));
    try {
      out.write("COMSOL case3_16core rebuild\n");
      out.write("===========================\n\n");
      out.write("Status: " + status + "\n");
      out.write("Mode: " + (BUILD_SMOKE_MODE ? "smoke coarse mesh" : "full reproducible mesh") + "\n");
      out.write("Config: " + path(cfg, "configPath") + "\n");
      out.write("Power input: " + path(cfg, "powerPath") + "\n");
      out.write("Power conversion: Q_W_per_m3 = power_cell_W / (dx * dy * dz)\n");
      out.write(String.format(Locale.US, "Cell volume: %.17g m^3\n\n", d(cfg, "dx") * d(cfg, "dx") * d(cfg, "dz")));
      out.write("Geometry:\n");
      out.write(String.format(Locale.US, "  domain: %.17g x %.17g m\n", d(cfg, "lx"), d(cfg, "ly")));
      out.write(String.format(Locale.US, "  bottom: %.17g m\n", d(cfg, "tBottom")));
      out.write(String.format(Locale.US, "  heat: %.17g m\n", d(cfg, "tHeat")));
      out.write(String.format(Locale.US, "  top: %.17g m\n\n", d(cfg, "tTop")));
      out.write("Materials:\n");
      out.write(String.format(Locale.US, "  source k: %.17g W/(m*K), selection sel_heat_dom\n", d(cfg, "kSource")));
      out.write(String.format(Locale.US, "  medium k: %.17g W/(m*K), selection sel_medium_dom\n\n", d(cfg, "kMedium")));
      out.write("Boundary conditions:\n");
      out.write(String.format(Locale.US, "  top Robin: HeatFlux/ConvectiveHeatFlux, h=%.17g W/(m^2*K), Text=%.17g K, selection sel_top_bnd\n", d(cfg, "hTop"), d(cfg, "ambient")));
      out.write(String.format(Locale.US, "  bottom Robin: HeatFlux/ConvectiveHeatFlux, h=%.17g W/(m^2*K), Text=%.17g K, selection sel_bottom_bnd\n", d(cfg, "hBottom"), d(cfg, "ambient")));
      out.write("  lateral Neumann zero flux: ThermalInsulation, selection sel_lateral_bnd\n\n");
      out.write("Selection boxes:\n");
      out.write("  sel_bottom_dom: z in [0, bottom]\n");
      out.write("  sel_heat_dom: z in [bottom, bottom+heat]\n");
      out.write("  sel_top_dom: z in [bottom+heat, total]\n");
      out.write("  sel_top_bnd: z = total exterior boundary\n");
      out.write("  sel_bottom_bnd: z = 0 exterior boundary\n");
      out.write("  sel_lateral_bnd: union of x=0, x=Lx, y=0, y=Ly exterior boundaries\n\n");
      out.write("Mesh:\n");
      if (BUILD_SMOKE_MODE) {
        out.write("  smoke coarse mesh: hmax=4 mm, hmin=500 um, hgrad=2.0\n\n");
      } else {
        out.write("  full mesh: hmax=dx_cell, hmin=dz_cell, hgrad=1.2\n\n");
      }
      out.write("Outputs expected after solve:\n");
      out.write("  query_temperatures.csv\n");
      out.write("  heat_layer_cell_center_temperatures.csv\n");
      out.write("  heat_layer_cell_center_temperatures.bin (float64 little-endian, iz-major then iy then ix)\n");
      out.write("  case3_rebuild.mph\n");
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
    if (DEFAULT_REPO_ROOT == null || DEFAULT_REPO_ROOT.trim().length() == 0) {
      throw new IllegalArgumentException("DEFAULT_REPO_ROOT must be set in comsol_case3_rebuild.java.");
    }
    Path root = Paths.get(DEFAULT_REPO_ROOT.trim()).normalize();
    if (!root.isAbsolute()) {
      throw new IllegalArgumentException("DEFAULT_REPO_ROOT must be absolute: " + DEFAULT_REPO_ROOT);
    }
    return root;
  }

  private static void writeFailure(Path outputDir, Exception ex) {
    try {
      if (outputDir == null) {
        outputDir = outputDir(repoRoot());
      }
      Files.createDirectories(outputDir);
      PrintWriter out = new PrintWriter(new FileWriter(outputDir.resolve("java_exception.txt").toFile()));
      try {
        ex.printStackTrace(out);
      } finally {
        out.close();
      }
    } catch (Throwable ignored) {
      // COMSOL's security manager can obscure the primary exception. Do not mask it.
    }
  }

  private static String meters(double value) {
    return Double.toString(value) + "[m]";
  }

  private static double d(Map cfg, String key) {
    return ((Double) cfg.get(key)).doubleValue();
  }

  private static int i(Map cfg, String key) {
    return ((Integer) cfg.get(key)).intValue();
  }

  private static int[] ints(Map cfg, String key) {
    return (int[]) cfg.get(key);
  }

  private static Path path(Map cfg, String key) {
    return (Path) cfg.get(key);
  }

  private static int checkedRound(double value, String name) {
    int rounded = (int) Math.round(value);
    if (Math.abs(value - rounded) > 1e-9) {
      throw new IllegalArgumentException(name + " is not integral: " + value);
    }
    return rounded;
  }

  private static boolean isTruthy(String value) {
    if (value == null) return false;
    String v = value.trim().toLowerCase(Locale.US);
    return v.equals("1") || v.equals("true") || v.equals("yes") || v.equals("on");
  }

  private static boolean hasKey(String json, String key) {
    return Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:").matcher(json).find();
  }

  private static double number(String json, String key, double fallback) {
    Matcher m = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*([-+0-9.eE]+)").matcher(json);
    return m.find() ? Double.parseDouble(m.group(1)) : fallback;
  }

  private static double boundaryParam(String json, String boundary, double fallback) {
    Matcher block = Pattern.compile("\"" + Pattern.quote(boundary) + "\"\\s*:\\s*\\{([^}]*)\\}", Pattern.DOTALL).matcher(json);
    if (!block.find()) return fallback;
    return number(block.group(1), "param", fallback);
  }

  private static String stringValue(String json, String key, String fallback) {
    Matcher m = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*\"([^\"]+)\"").matcher(json);
    return m.find() ? m.group(1) : fallback;
  }

  private static int[] intArray(String json, String key, int[] fallback) {
    Matcher m = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*\\[([^]]*)\\]").matcher(json);
    if (!m.find()) return fallback;
    String[] parts = m.group(1).split(",");
    int[] out = new int[parts.length];
    for (int i = 0; i < parts.length; i++) {
      out[i] = Integer.parseInt(parts[i].trim());
    }
    return out;
  }

  private static void writeLittleEndianDouble(DataOutputStream out, double value) throws IOException {
    long bits = Double.doubleToLongBits(value);
    out.writeLong(Long.reverseBytes(bits));
  }
}
