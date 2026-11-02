/**
 * ESTÜ 2050 Kampüs Sürdürülebilirlik & İklim Dirençliliği Hesap Motoru
 * window.ESTU = { DEF, PRESETS, run(p, n), mc(p, N) }
 */
(function (root) {
  'use strict';

  var DEF = {
    ges: 65,          // GES Çatı Payı (%)
    cistern: 3500,    // Sarnıç Hacmi (m³)
    battery: 4.2,     // BESS Batarya (MWh)
    pop: 14500,       // Eşdeğer Nüfus (kişi)
    roof: 82000,      // Çatı Alanı (m²)
    tariff: 0.14,     // Elektrik Fiyatı ($/kWh)
    greywater: true,  // Rezervuarda Yağmur/Gri Su
    compost: true,    // Yemekhane Biyo-Kompost
    esco: false,      // ESCO / EPS Finansmanı
    horizon: 2030     // Hedef Ufku (2030 / 2040 / 2050)
  };

  var PRESETS = {
    A: {
      name: 'Mevcut Durum (2024)',
      code: 'S-1 (Baz Senaryo)',
      ges: 20,
      cistern: 800,
      battery: 0.8,
      pop: 14500,
      roof: 82000,
      tariff: 0.14,
      greywater: false,
      compost: false,
      esco: false
    },
    B: {
      name: 'Kademeli Müdahale (2–5 Yıl)',
      code: 'S-3 (Dirençli Kampüs)',
      ges: 65,
      cistern: 3500,
      battery: 4.2,
      pop: 14500,
      roof: 82000,
      tariff: 0.14,
      greywater: true,
      compost: true,
      esco: false
    },
    C: {
      name: 'Tam Dönüşüm & Net-Zero',
      code: 'S-5 (Net-Sıfır 2050)',
      ges: 95,
      cistern: 5500,
      battery: 8.5,
      pop: 14500,
      roof: 82000,
      tariff: 0.14,
      greywater: true,
      compost: true,
      esco: true
    }
  };

  // Eskişehir (MGM İstasyon 17124) aylık güneşlenme çarpanları (toplam = 1.0)
  var SOLAR_M = [0.038, 0.050, 0.075, 0.096, 0.118, 0.135, 0.144, 0.138, 0.104, 0.072, 0.044, 0.034];
  var SOLAR_SUM = SOLAR_M.reduce(function (a, b) { return a + b; }, 0);
  SOLAR_M = SOLAR_M.map(function (v) { return v / SOLAR_SUM; });

  // Kampüs aylık elektrik talep profili (toplam = 1.0)
  var DEMAND_M = [0.098, 0.092, 0.085, 0.080, 0.074, 0.068, 0.064, 0.066, 0.076, 0.084, 0.090, 0.100];
  var DEMAND_SUM = DEMAND_M.reduce(function (a, b) { return a + b; }, 0);
  DEMAND_M = DEMAND_M.map(function (v) { return v / DEMAND_SUM; });

  // Eskişehir aylık ortalama yağış (mm) - MGM arşivi (~397 mm/yıl)
  var RAIN_MM = [38, 34, 41, 48, 54, 31, 14, 12, 19, 34, 37, 45];

  function mergeParams(p) {
    var out = {};
    for (var k in DEF) {
      if (Object.prototype.hasOwnProperty.call(DEF, k)) {
        out[k] = (p && p[k] !== undefined) ? p[k] : DEF[k];
      }
    }
    out.ges = Number(out.ges);
    out.cistern = Number(out.cistern);
    out.battery = Number(out.battery);
    out.pop = Number(out.pop);
    out.roof = Number(out.roof);
    out.tariff = Number(out.tariff);
    out.greywater = Boolean(out.greywater);
    out.compost = Boolean(out.compost);
    out.esco = Boolean(out.esco);
    out.horizon = Number(out.horizon || 2030);
    return out;
  }

  /**
   * Deterministik veya tekil stokastik simülasyon çalıştırır.
   * Çıktı alanları: kwp, prod, S, X, cov, self, wCov, autoW, autoE, over, capex, npv, pb, co2, mp, md, tl, cf
   */
  function run(p, noise) {
    var cfg = mergeParams(p);
    var nIrr = (noise && noise.irr) ? noise.irr : 1.0;
    var nRain = (noise && noise.rain) ? noise.rain : 1.0;
    var nTar = (noise && noise.tar) ? noise.tar : 1.0;
    var nCap = (noise && noise.cap) ? noise.cap : 1.0;

    var hFactor = cfg.horizon === 2050 ? 1.06 : (cfg.horizon === 2040 ? 1.03 : 1.0);
    var droughtFactor = cfg.horizon === 2050 ? 0.90 : (cfg.horizon === 2040 ? 0.95 : 1.0);

    // 1. GES kurulu güç (kWp) ve yıllık üretim (MWh)
    var activeRoof = cfg.roof * (cfg.ges / 100);
    var kwp = Math.round(activeRoof * 0.15797);
    var yieldPerKwp = 1.3349 * nIrr * hFactor;
    var prod = kwp * yieldPerKwp;

    // 2. Elektrik talebi (MWh/yıl) ve öz-tüketim / ihracat (S, X)
    var totalDemand = cfg.pop * 1.0503; // ~15.229 MWh/yıl
    var mp = [];
    var md = [];
    var S = 0;
    var X = 0;

    // BESS batarya kapasitesi gündüz-gece kaydırma verimini artırır
    var battBoost = Math.min(0.32, (cfg.battery / 4.2) * 0.195);

    for (var m = 0; m < 12; m++) {
      var mProd = prod * SOLAR_M[m];
      var mDem = totalDemand * DEMAND_M[m];
      mp.push(Number(mProd.toFixed(1)));
      md.push(Number(mDem.toFixed(1)));

      var absorbCap = mDem * (0.98 + battBoost);
      var mSelf = Math.min(mProd, absorbCap);
      var mExp = Math.max(0, mProd - mSelf);
      S += mSelf;
      X += mExp;
    }

    var cov = totalDemand > 0 ? (prod / totalDemand) * 100 : 0;
    var self = prod > 0 ? (S / prod) * 100 : 100;

    // 3. Su döngüsü, sarnıç doluluğu (tl), pik yağış aşımı (over), su otonomisi (autoW)
    var annualWaterNeed = cfg.pop * 54.138; // ~785.000 m³/yıl
    var catchmentArea = cfg.roof * 2.4 + 260000;
    var runoffCoeff = 0.84;
    var greySaved = cfg.greywater ? (annualWaterNeed * 0.2356) : 0; // ~185.000 m³
    var rainHarvested = 0;
    var over = 0;
    var tl = [];

    for (var w = 0; w < 12; w++) {
      var mRainMm = RAIN_MM[w] * nRain * droughtFactor;
      var inflow = (mRainMm / 1000) * catchmentArea * runoffCoeff;
      var capCapture = (cfg.cistern / 3500) * 19500 + 4500;
      var captured = Math.min(inflow, capCapture);
      rainHarvested += captured;

      // Sarnıç kapasitesini aşan pik yağış / taşkın hacmi (over)
      var monthOver = Math.max(0, (inflow - captured) * 0.12 + Math.max(0, (3800 - cfg.cistern) * 0.04));
      over += monthOver;

      // Mevsimsel sarnıç doluluk profili (m³)
      var seasonalWave = Math.sin(((w + 1.5) / 12) * Math.PI * 2) * (cfg.cistern * 0.28);
      var level = Math.max(0, Math.min(cfg.cistern, (cfg.cistern * 0.67) + seasonalWave * nRain));
      tl.push(Math.round(level));
    }

    var rainUsed = Math.min(annualWaterNeed * 0.45, rainHarvested * 1.02);
    var totalRecoveredWater = Math.min(annualWaterNeed * 0.88, rainUsed + greySaved);
    var wCov = annualWaterNeed > 0 ? (totalRecoveredWater / annualWaterNeed) * 100 : 0;

    // Su otonomisi (gün) ve Elektrik otonomisi (saat)
    var criticalDailyWater = cfg.pop * 0.0082;
    var autoW = criticalDailyWater > 0
      ? Math.round((cfg.cistern * (cfg.greywater ? 1.428 : 1.05)) / criticalDailyWater)
      : 0;

    var criticalMw = (totalDemand / 8760) * 0.1585;
    var solarBufferMwh = (kwp / 8420) * 0.88;
    var autoE = criticalMw > 0 ? ((cfg.battery + solarBufferMwh) / criticalMw) : 0;

    // 4. Finansal Analiz: CAPEX, NPV, Geri Ödeme (pb), Kümülatif Nakit Akışı (cf)
    var rawCapex = (
      kwp * 395 +
      cfg.battery * 215000 +
      cfg.cistern * 125 +
      (cfg.greywater ? 120000 : 0) +
      (cfg.compost ? 65000 : 0)
    ) * nCap;

    var capex = cfg.esco ? rawCapex * 0.68 : rawCapex;
    var effTariff = cfg.tariff * nTar;

    // Şebeke dağıtım/kapasite bedelleri düşüldükten sonraki net enerji + su + kompost tasarrufu
    var elecSavingYr = (S * 1000 * effTariff * 0.48) + (X * 1000 * effTariff * 0.30);
    var waterSavingYr = totalRecoveredWater * 0.575;
    var compostSavingYr = cfg.compost ? 48000 : 0;
    var omCostYr = rawCapex * 0.032;

    var baseAnnualNet = elecSavingYr + waterSavingYr + compostSavingYr - omCostYr;

    var discountRate = 0.08;
    var npv = -capex;
    var cf = [Number((-capex).toFixed(0))];
    var cumDisc = -capex;
    var pb = 25.0;
    var pbFound = false;

    for (var yr = 1; yr <= 25; yr++) {
      var deg = Math.pow(0.994, yr - 1);
      var esc = Math.pow(1.015, yr - 1);
      var escoShare = (cfg.esco && yr <= 10) ? 0.78 : 1.0;
      var yrCash = baseAnnualNet * deg * esc * escoShare;
      var discCash = yrCash / Math.pow(1 + discountRate, yr);
      var prevCum = cumDisc;
      cumDisc += discCash;
      npv = cumDisc;
      cf.push(Number(cumDisc.toFixed(0)));

      if (!pbFound && cumDisc >= 0 && discCash > 0) {
        pb = (yr - 1) + Math.abs(prevCum) / discCash;
        pbFound = true;
      }
    }

    var simplePb = baseAnnualNet > 0 ? (capex / baseAnnualNet) : 25.0;
    pb = Math.max(1.2, Math.min(25.0, simplePb * 0.96));

    var irr = capex > 0 ? Math.max(0, Math.min(35, (baseAnnualNet / capex) * 100 + 0.5)) : 0;

    // 5. Karbon Azaltımı (tCO₂ / yıl)
    var co2 = Math.round(
      prod * 0.342 +
      (cfg.compost ? 218 : 0) +
      (totalRecoveredWater * 0.00033)
    );

    return {
      kwp: Math.round(kwp),
      prod: Math.round(prod),
      S: Math.round(S),
      X: Math.round(X),
      cov: Number(cov.toFixed(1)),
      self: Number(self.toFixed(1)),
      wCov: Number(wCov.toFixed(1)),
      autoW: Math.round(autoW),
      autoE: Number(autoE.toFixed(1)),
      over: Math.round(over),
      capex: Math.round(capex),
      npv: Math.round(npv),
      pb: Number(pb.toFixed(1)),
      co2: Math.round(co2),
      mp: mp,
      md: md,
      tl: tl,
      cf: cf,
      irr: Number(irr.toFixed(1)),
      activeRoof: Math.round(activeRoof),
      totalDemand: Math.round(totalDemand),
      annualNet: Math.round(baseAnnualNet),
      wGrid: Math.max(0, Math.round(annualWaterNeed - totalRecoveredWater)),
      wRain: Math.round(rainUsed),
      wGrey: Math.round(greySaved),
      wSaveUsd: Math.round(waterSavingYr),
      trees: Math.round(co2 * 1.866),
      netZeroPct: Number(Math.min(100, (co2 / 4728) * 100).toFixed(1)),
      peakMw: Number(((totalDemand / 8760) * 2.76).toFixed(1))
    };
  }

  function mulberry32(seed) {
    return function () {
      var t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Monte Carlo Simülasyonu (varsayılan N = 5000)
   * Çıktı alanları: a, p10, p50, p90, pPos, pb50
   */
  function mc(p, N) {
    var iter = N || 5000;
    var cfg = mergeParams(p);
    var seed = Math.round(cfg.ges * 137 + cfg.cistern * 13 + cfg.battery * 97 + cfg.pop + cfg.roof + cfg.tariff * 10000);
    var rand = mulberry32(seed);

    function randNormal() {
      var u = Math.max(1e-7, rand());
      var v = Math.max(1e-7, rand());
      return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    }

    var a = new Array(iter);
    var pbs = new Array(iter);
    var posCount = 0;
    var sum = 0;

    for (var i = 0; i < iter; i++) {
      var z1 = randNormal();
      var z2 = randNormal();
      var z3 = randNormal();
      var z4 = randNormal();

      var noise = {
        irr: Math.max(0.65, Math.min(1.35, 1.0 + z1 * 0.10)),
        rain: Math.max(0.60, Math.min(1.40, 1.0 + z2 * 0.16)),
        tar: Math.max(0.60, Math.min(1.45, 1.0 + z3 * 0.15)),
        cap: Math.max(0.75, Math.min(1.30, 1.0 + z4 * 0.08))
      };

      var res = run(cfg, noise);
      a[i] = res.npv;
      pbs[i] = res.pb;
      sum += res.npv;
      if (res.npv > 0) posCount++;
    }

    a.sort(function (x, y) { return x - y; });
    pbs.sort(function (x, y) { return x - y; });

    var p10 = a[Math.floor(iter * 0.10)];
    var p50 = a[Math.floor(iter * 0.50)];
    var p90 = a[Math.floor(iter * 0.90)];
    var pb50 = pbs[Math.floor(iter * 0.50)];
    var pPos = Number(((posCount / iter) * 100).toFixed(1));

    var mean = sum / iter;
    var sqDiff = 0;
    for (var j = 0; j < iter; j++) {
      var d = a[j] - mean;
      sqDiff += d * d;
    }
    var std = Math.round(Math.sqrt(sqDiff / iter));

    return {
      a: a,
      p10: Math.round(p10),
      p50: Math.round(p50),
      p90: Math.round(p90),
      pPos: pPos,
      pb50: Number(pb50.toFixed(1)),
      std: std
    };
  }

  root.ESTU = {
    DEF: DEF,
    PRESETS: PRESETS,
    run: run,
    mc: mc
  };
})(typeof window !== 'undefined' ? window : globalThis);
