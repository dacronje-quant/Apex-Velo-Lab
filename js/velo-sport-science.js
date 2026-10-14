/**
 * APEX VELO // LAB - Sport-science evidence base.
 *
 * A curated, graded summary of the research behind the coach's decisions. It is used two ways:
 *  - The AI prompts get a short EVIDENCE BRIEF: the goal's physiological model plus only the
 *    entries that matter for this goal and this rider (fatigue, recovery data, strength work,
 *    limited hours, notes such as an event or age). The model may cite only these references;
 *    any other citation it returns is dropped (verifyRef), so the app never shows invented studies.
 *  - The offline engine shows the same entries as "The science behind this" and follows them
 *    (session progression, VO2 work for longevity, fuelling, strength and taper advice).
 *
 * Grades: A = meta-analyses or several randomised trials; B = randomised trials in cyclists or
 * large cohort data; C = practitioner consensus or limited trials.
 * Review the entries when new meta-analyses appear and bump REVIEWED.
 */
class VeloSportScience {
  static REVIEWED = '2026-10';
  static GRADES = {
    A: 'meta-analyses or several randomised trials',
    B: 'randomised trials in cyclists or large cohort studies',
    C: 'practitioner consensus or limited trials'
  };

  /**
   * Evidence entries. `principle` is for the AI (technical, with doses); `plain` is shown to the rider
   * (everyday words, no acronyms); `refs` are the only citations the app will display.
   */
  static EVIDENCE = {
    tid: {
      topic: 'Intensity distribution',
      grade: 'A',
      principle: 'Most training time should sit below the first lactate threshold (Zone 1-2, roughly 75-85% of sessions). Polarised and pyramidal distributions both work; polarised shows a small extra benefit for VO2peak mainly in well-trained athletes over short (<12 week) blocks, with no clear difference in time-trial performance. Riders with little time (<5-6 h/week) can use a larger share of threshold/SweetSpot work (pyramidal) for time efficiency.',
      plain: 'Keep most rides truly easy so the hard ones can be done well. Both "mostly easy with a few very hard" and "mostly easy with some steady-hard" approaches work.',
      refs: ['Seiler & Kjerland, 2006', 'Stöggl & Sperlich, 2014', 'Rosenblat et al., 2019', 'Oliveira et al., 2024', 'Burnley et al., 2022']
    },
    vo2_short: {
      topic: 'Short hard intervals',
      grade: 'B',
      principle: 'Short intervals (3 sets of 13 x 30 s hard / 15 s easy, 3 min between sets, at the highest power the rider can repeat) gave larger gains in VO2max, maximal aerobic power and 40-min power than effort-matched 4-5 min intervals in trained and elite cyclists.',
      plain: 'Short hard bursts with very short breaks let you spend more total time working near your limit than long efforts do.',
      refs: ['Rønnestad et al., 2015', 'Rønnestad et al., 2020']
    },
    vo2_long: {
      topic: 'Longer hard intervals',
      grade: 'A',
      principle: 'Intervals of 3-8 min at 90-95% HRmax (about 106-120% FTP for 3-5 min; ~100-105% for 8 min) raise VO2max. Accumulated time above ~90% VO2max (10+ min per session) is the main driver. 4 x 8 min at a sustainable hard effort beat 4 x 4 min and 4 x 16 min in recreational cyclists. Work:rest of about 1:1 to 2:1.',
      plain: 'Efforts of three to eight minutes at a hard but repeatable pace build the size of your aerobic engine.',
      refs: ['Helgerud et al., 2007', 'Seiler et al., 2013', 'Buchheit & Laursen, 2013']
    },
    hit_block: {
      topic: 'Block periodisation of hard sessions',
      grade: 'C',
      principle: 'Concentrating high-intensity sessions (e.g. 5 in one week, then 1 per week) gave larger gains than spreading them evenly in trained cyclists; the meta-analysis effect is small and certainty low. Use only for experienced riders who recover well, never for beginners or when fatigued.',
      plain: 'Experienced riders can sometimes group hard sessions into a short focused block, followed by easier weeks.',
      refs: ['Rønnestad et al., 2014', 'Mølmen et al., 2019']
    },
    threshold: {
      topic: 'Threshold and SweetSpot work',
      grade: 'C',
      principle: 'Work at 88-105% FTP builds sustainable power with a good training effect per hour, but evidence is mostly practice-based and from mixed-intensity studies. Progress by extending time in zone (e.g. 2 x 10 -> 2 x 20 -> 3 x 20 min, or shorter rests) before raising intensity. Keep these sessions inside an otherwise easy week.',
      plain: 'Long, steady efforts just below your limit raise the power you can hold. Make them longer before you make them harder.',
      refs: ['Seiler, 2010', 'Neal et al., 2013']
    },
    progression: {
      topic: 'Progressive overload and lighter weeks',
      grade: 'C',
      principle: 'Raise load gradually (practical guide: 3-5 fitness (CTL) points per week; less for beginners or when fatigued), progress the volume of key work before its intensity, and include a lighter week every 3-4 weeks (load down ~30-50%, a little intensity kept). Load ratios such as acute:chronic are not validated injury predictors; use them as guides only.',
      plain: 'Build a little at a time, and take an easier week every few weeks so the training can sink in.',
      refs: ['Issurin, 2010', 'Mujika et al., 2018', 'Impellizzeri et al., 2020']
    },
    taper: {
      topic: 'Tapering before a test or event',
      grade: 'A',
      principle: 'Over 8-14 days before a test or event, cut volume by about 40-60% while keeping intensity and most of the training frequency. This typically improves performance by about 2-3%.',
      plain: 'Before a test or event, ride less but keep a few short hard efforts so you arrive fresh and sharp.',
      refs: ['Bosquet et al., 2007', 'Mujika & Padilla, 2003']
    },
    durability: {
      topic: 'Durability',
      grade: 'C',
      principle: 'Durability (how well power and thresholds hold after prolonged work, e.g. 2-3 h or 1500-3000 kJ) separates performance between riders with similar fresh profiles. It is built with long low-intensity rides, overall volume, good fuelling and, once tolerated, quality efforts late in long rides.',
      plain: 'Long easy rides teach your body to keep going strongly late in a ride, not just when fresh.',
      refs: ['Maunder et al., 2021']
    },
    longevity_crf: {
      topic: 'Fitness and long-term health',
      grade: 'A',
      principle: 'Cardiorespiratory fitness (VO2max) is among the strongest modifiable predictors of all-cause mortality. For health and longevity: mostly moderate volume plus 1-2 weekly high-intensity sessions (e.g. 4 x 4 min at 85-95% HRmax, 3 min easy between), and muscle-strengthening work at least twice a week (WHO 2020).',
      plain: 'A bigger aerobic engine is one of the strongest links to a long, healthy life. Mostly easy riding, one or two short hard sessions a week and some strength work cover it.',
      refs: ['Mandsager et al., 2018', 'Stensvold et al., 2020', 'Bull et al., 2020']
    },
    strength: {
      topic: 'Strength training for cyclists',
      grade: 'A',
      principle: 'Heavy strength training (2 sessions/week, ~4-10 repetition maximum, multi-joint leg exercises, 8-12 weeks) added to endurance training improves cycling economy, power and performance without blunting endurance gains. Place it on hard days (after the ride) or at least 24-48 h before a key ride. Muscle-strengthening work is also linked to lower all-cause mortality.',
      plain: 'Two short, heavy leg-strength sessions a week make each pedal stroke cheaper. Put them on hard days or well before your next hard ride.',
      refs: ['Rønnestad & Mujika, 2014', 'Vikmoen et al., 2016', 'Momma et al., 2022']
    },
    hrv: {
      topic: 'Recovery-guided training',
      grade: 'B',
      principle: 'Adjusting each day to heart-rate variability (lower intensity when HRV falls below the rider\'s normal range, train as planned when it is normal) gave equal or better gains than fixed plans in cyclists and other endurance athletes.',
      plain: 'Letting your morning recovery readings decide between a hard and an easy day works at least as well as a fixed plan.',
      refs: ['Kiviniemi et al., 2007', 'Javaloyes et al., 2019']
    },
    fueling: {
      topic: 'Fuelling',
      grade: 'A',
      principle: 'Fuel the work required: 60-90 g carbohydrate per hour on rides over ~90 min and in hard sessions (glucose + fructose mixes above 60 g/h; up to 90-120 g/h is emerging for trained guts). Deliberate "train low" did not give superior adaptations in elite athletes. Protein about 1.6 g/kg/day supports adaptation.',
      plain: 'Eat and drink on longer and harder rides so you can finish them well. Under-fuelling does not make you fitter.',
      refs: ['Jeukendrup, 2014', 'Thomas et al., 2016', 'Impey et al., 2018', 'Gejl et al., 2017', 'Morton et al., 2018']
    },
    recovery: {
      topic: 'Sleep, fatigue and overreaching',
      grade: 'B',
      principle: 'Sleep 7-9 h; sleep restriction impairs performance and recovery. Overreaching is identified by a drop in performance with mood or wellbeing changes, not by load metrics alone; when fatigued, reduce intensity first and keep easy volume short.',
      plain: 'Sleep is part of training. When you are worn down, cut the hard work first and rest until your legs come back.',
      refs: ['Walsh et al., 2021', 'Meeusen et al., 2013']
    },
    time_efficient: {
      topic: 'Training with limited time',
      grade: 'A',
      principle: 'With limited time, high-intensity interval training improves VO2max at least as much as continuous moderate training. As hours allow, total aerobic volume becomes the bigger driver, so add easy time before adding more hard sessions.',
      plain: 'With little time, short hard sessions give a lot of benefit. If you get more time, add easy riding first.',
      refs: ['Milanović et al., 2015', 'Gibala et al., 2012']
    },
    ftp_test: {
      topic: 'Testing and individual response',
      grade: 'B',
      principle: 'A ramp-test FTP (~75% of best 1-min power) is an estimate that can mis-judge riders with strong anaerobic or aerobic profiles and is not identical to lactate threshold. Responses to the same training vary widely between people, so re-test every 4-8 weeks and adjust targets to the rider\'s own data.',
      plain: 'A power test is an estimate. People respond differently to the same training, so retest regularly and let your own results steer the plan.',
      refs: ['Valenzuela et al., 2018', 'Mann et al., 2014']
    },
    masters: {
      topic: 'Older (masters) riders',
      grade: 'C',
      principle: 'Endurance performance declines with age mainly through VO2max; keeping some high-intensity work and strength training preserves it best. Older riders often need more recovery between hard sessions (consider 2 key sessions per week and longer gaps).',
      plain: 'With age, keeping some hard efforts and strength work matters even more, with a little more rest between hard days.',
      refs: ['Tanaka & Seals, 2008']
    },
    menstrual: {
      topic: 'Menstrual cycle',
      grade: 'B',
      principle: 'A meta-analysis (mostly low-quality studies) found that, on average, menstrual-cycle phase has only a trivial effect on performance; individual responses vary, so adjust to the rider\'s own symptoms rather than fixed phase rules.',
      plain: 'On average your cycle phase changes performance very little. Adjust to how you feel rather than to fixed rules.',
      refs: ['McNulty et al., 2020']
    }
  };

  /** Full references for the short citations above (shown in the app; the AI may cite only these). */
  static REFERENCES = {
    'Seiler & Kjerland, 2006': 'Seiler S, Kjerland GØ. Quantifying training intensity distribution in elite endurance athletes. Scand J Med Sci Sports. 2006.',
    'Stöggl & Sperlich, 2014': 'Stöggl T, Sperlich B. Polarized training has greater impact on key endurance variables than threshold, high intensity, or high volume training. Front Physiol. 2014.',
    'Rosenblat et al., 2019': 'Rosenblat MA, Perrotta AS, Vicenzino B. Polarized vs. threshold training intensity distribution on endurance sport performance: a systematic review and meta-analysis. J Strength Cond Res. 2019.',
    'Oliveira et al., 2024': 'Oliveira PS, Boppre G, Fonseca H. Comparison of polarized versus other types of endurance training intensity distribution: a systematic review with meta-analysis. Sports Med. 2024.',
    'Burnley et al., 2022': 'Burnley M, Bearden SE, Jones AM. Polarized training is not optimal for endurance athletes. Med Sci Sports Exerc. 2022.',
    'Rønnestad et al., 2015': 'Rønnestad BR, Hansen J, Vegge G, Tønnessen E, Slettaløkken G. Short intervals induce superior training adaptations compared with long intervals in cyclists. Scand J Med Sci Sports. 2015.',
    'Rønnestad et al., 2020': 'Rønnestad BR, Hansen J, Nygaard H, Lundby C. Superior performance improvements in elite cyclists following short-interval vs effort-matched long-interval training. Scand J Med Sci Sports. 2020.',
    'Helgerud et al., 2007': 'Helgerud J, et al. Aerobic high-intensity intervals improve VO2max more than moderate training. Med Sci Sports Exerc. 2007.',
    'Seiler et al., 2013': 'Seiler S, Jøranson K, Olesen BV, Hetlelid KJ. Adaptations to aerobic interval training: interactive effects of exercise intensity and total work duration. Scand J Med Sci Sports. 2013.',
    'Buchheit & Laursen, 2013': 'Buchheit M, Laursen PB. High-intensity interval training, solutions to the programming puzzle. Sports Med. 2013.',
    'Rønnestad et al., 2014': 'Rønnestad BR, Hansen J, Ellefsen S. Block periodization of high-intensity aerobic intervals provides superior training effects in trained cyclists. Scand J Med Sci Sports. 2014.',
    'Mølmen et al., 2019': 'Mølmen KS, Øfsteng SJ, Rønnestad BR. Block periodization of endurance training: a systematic review and meta-analysis. BMJ Open Sport Exerc Med. 2019.',
    'Seiler, 2010': 'Seiler S. What is best practice for training intensity and duration distribution in endurance athletes? Int J Sports Physiol Perform. 2010.',
    'Neal et al., 2013': 'Neal CM, et al. Six weeks of a polarized training-intensity distribution leads to greater physiological and performance adaptations than a threshold model in trained cyclists. J Appl Physiol. 2013.',
    'Issurin, 2010': 'Issurin VB. New horizons for the methodology and physiology of training periodization. Sports Med. 2010.',
    'Mujika et al., 2018': 'Mujika I, et al. An integrated, multifactorial approach to periodization for optimal performance in individual and team sports. Int J Sports Physiol Perform. 2018.',
    'Impellizzeri et al., 2020': 'Impellizzeri FM, et al. Acute:chronic workload ratio: conceptual issues and fundamental pitfalls. Int J Sports Physiol Perform. 2020.',
    'Bosquet et al., 2007': 'Bosquet L, Montpetit J, Arvisais D, Mujika I. Effects of tapering on performance: a meta-analysis. Med Sci Sports Exerc. 2007.',
    'Mujika & Padilla, 2003': 'Mujika I, Padilla S. Scientific bases for precompetition tapering strategies. Med Sci Sports Exerc. 2003.',
    'Maunder et al., 2021': 'Maunder E, Seiler S, Mildenhall MJ, Kilding AE, Plews DJ. The importance of "durability" in the physiological profiling of endurance athletes. Sports Med. 2021.',
    'Mandsager et al., 2018': 'Mandsager K, et al. Association of cardiorespiratory fitness with long-term mortality among adults undergoing exercise treadmill testing. JAMA Netw Open. 2018.',
    'Stensvold et al., 2020': 'Stensvold D, et al. Effect of exercise training for five years on all cause mortality in older adults: the Generation 100 study. BMJ. 2020.',
    'Bull et al., 2020': 'Bull FC, et al. World Health Organization 2020 guidelines on physical activity and sedentary behaviour. Br J Sports Med. 2020.',
    'Rønnestad & Mujika, 2014': 'Rønnestad BR, Mujika I. Optimizing strength training for running and cycling endurance performance: a review. Scand J Med Sci Sports. 2014.',
    'Vikmoen et al., 2016': 'Vikmoen O, et al. Strength training improves cycling performance, fractional utilization of VO2max and cycling economy in female cyclists. Scand J Med Sci Sports. 2016.',
    'Momma et al., 2022': 'Momma H, et al. Muscle-strengthening activities are associated with lower risk and mortality in major non-communicable diseases. Br J Sports Med. 2022.',
    'Kiviniemi et al., 2007': 'Kiviniemi AM, et al. Endurance training guided individually by daily heart rate variability measurements. Eur J Appl Physiol. 2007.',
    'Javaloyes et al., 2019': 'Javaloyes A, Sarabia JM, Lamberts RP, Moya-Ramon M. Training prescription guided by heart-rate variability in cycling. Int J Sports Physiol Perform. 2019.',
    'Jeukendrup, 2014': 'Jeukendrup A. A step towards personalized sports nutrition: carbohydrate intake during exercise. Sports Med. 2014.',
    'Thomas et al., 2016': 'Thomas DT, Erdman KA, Burke LM. Nutrition and athletic performance (ACSM / Academy / Dietitians of Canada position). Med Sci Sports Exerc. 2016.',
    'Impey et al., 2018': 'Impey SG, et al. Fuel for the work required: a theoretical framework for carbohydrate periodization and the glycogen threshold hypothesis. Sports Med. 2018.',
    'Gejl et al., 2017': 'Gejl KD, et al. No superior adaptations to carbohydrate periodization in elite endurance athletes. Med Sci Sports Exerc. 2017.',
    'Morton et al., 2018': 'Morton RW, et al. A systematic review, meta-analysis and meta-regression of the effect of protein supplementation on resistance training-induced gains. Br J Sports Med. 2018.',
    'Walsh et al., 2021': 'Walsh NP, et al. Sleep and the athlete: narrative review and 2021 expert consensus recommendations. Br J Sports Med. 2021.',
    'Meeusen et al., 2013': 'Meeusen R, et al. Prevention, diagnosis, and treatment of the overtraining syndrome (ECSS / ACSM joint consensus). Med Sci Sports Exerc. 2013.',
    'Milanović et al., 2015': 'Milanović Z, Sporiš G, Weston M. Effectiveness of high-intensity interval training and continuous endurance training for VO2max improvements: a systematic review and meta-analysis. Sports Med. 2015.',
    'Gibala et al., 2012': 'Gibala MJ, Little JP, MacDonald MJ, Hawley JA. Physiological adaptations to low-volume, high-intensity interval training in health and disease. J Physiol. 2012.',
    'Valenzuela et al., 2018': 'Valenzuela PL, et al. Is the functional threshold power a valid surrogate of the lactate threshold? Int J Sports Physiol Perform. 2018.',
    'Mann et al., 2014': 'Mann TN, Lamberts RP, Lambert MI. High responders and low responders: factors associated with individual variation in response to standardized training. Sports Med. 2014.',
    'Tanaka & Seals, 2008': 'Tanaka H, Seals DR. Endurance exercise performance in Masters athletes: age-associated changes and underlying physiological mechanisms. J Physiol. 2008.',
    'McNulty et al., 2020': 'McNulty KL, et al. The effects of menstrual cycle phase on exercise performance in eumenorrheic women: a systematic review and meta-analysis. Sports Med. 2020.'
  };

  /** What each goal depends on physiologically, how to distribute intensity, and the key-session menu with doses. */
  static GOAL_MODELS = {
    ftp: {
      determinants: 'power at the lactate threshold (fractional use of VO2max), the VO2max ceiling and the aerobic base behind both',
      distribution: 'pyramidal: most time easy, a meaningful share at SweetSpot/threshold, a little VO2 work; shift towards polarised in the final weeks',
      menu: 'SweetSpot 2-3 x 12-20 min at 88-94% FTP; threshold 2-3 x 10-20 min at 95-100% or over-unders (95/105%); one VO2 session (5 x 4 min at 106-115% or 30/15 sets) per week in build and peak phases',
      progression: 'extend time in zone (e.g. 40 -> 60 -> 75 min total at SweetSpot) or shorten rests before raising targets',
      avoid: 'stacking threshold days back to back, and grey-zone easy rides that are too hard to recover from',
      evidence: ['tid', 'threshold', 'vo2_long', 'progression', 'strength', 'ftp_test']
    },
    vo2: {
      determinants: 'VO2max and maximal aerobic power, supported by threshold power so the gains can be used',
      distribution: 'polarised: two (three for well-trained riders who recover well) high-intensity sessions per week, the rest easy',
      menu: '30/15 s sets (2-3 x 13 reps, 3 min between sets); 4-6 x 3-5 min at 106-120% FTP (90-95% HRmax) with equal rest; 4 x 8 min at a hard, even pace for longer intervals; aim for 10-20 min near VO2max per session',
      progression: 'add repetitions or sets first, then shorten rests; keep at least 48 h between hard days',
      avoid: 'more than three high-intensity sessions per week, or hard sessions when recovery readings are poor',
      evidence: ['vo2_short', 'vo2_long', 'hit_block', 'tid', 'progression']
    },
    longevity: {
      determinants: 'cardiorespiratory fitness (VO2max), durability, metabolic health and muscle strength',
      distribution: 'mostly Zone 2 volume, one (or two) short high-intensity sessions a week, plus strength training twice a week',
      menu: 'long Zone 2 rides; 4 x 4 min at 85-95% HRmax with 3 min easy (Norwegian 4 x 4) once a week; an occasional SweetSpot session for variety; strength work off the bike',
      progression: 'grow the long ride and weekly easy time first; keep the weekly hard session short and repeatable',
      avoid: 'only ever riding easy (VO2max is the strongest fitness link to longevity) and skipping strength work',
      evidence: ['longevity_crf', 'strength', 'durability', 'tid', 'recovery']
    },
    balanced: {
      determinants: 'all energy systems: aerobic base, threshold power and VO2max',
      distribution: 'polarised around 80% easy / 20% hard, rotating the hard sessions between VO2 and threshold work',
      menu: 'one VO2 session (30/15 s or 4-5 min efforts) and one threshold or SweetSpot session per week, plus a long easy ride',
      progression: 'rotate stimuli and grow the time in each zone gradually',
      avoid: 'letting easy rides drift into moderate intensity',
      evidence: ['tid', 'vo2_short', 'threshold', 'durability', 'progression']
    }
  };

  // --------------------------------------------------------------- selection --
  /** Evidence ids that apply to this goal and rider, most relevant first. kind: 'session' | 'block'. */
  static select(goal, ctx = {}, kind = 'session') {
    const model = VeloSportScience.GOAL_MODELS[goal] || VeloSportScience.GOAL_MODELS.ftp;
    const ids = [...model.evidence];
    const add = (id) => { if (!ids.includes(id) && VeloSportScience.EVIDENCE[id]) ids.push(id); };
    const h = ctx.history || {};
    const notes = String(ctx.notes || '').toLowerCase();
    if (ctx.readiness) add('hrv');
    if ((ctx.tsb || 0) < -15 || (ctx.readiness && ctx.readiness.level !== 'green')) add('recovery');
    const strengthCount = (ctx.strength && ctx.strength.count) || 0;
    if (strengthCount > 0 || /strength|gym|weights|squat|deadlift/.test(notes)) add('strength');
    const weeklyHours = Number(ctx.hoursPerWeek || h.hoursPerWeekWin || h.hoursPerWeek4w);
    if (Number.isFinite(weeklyHours) && weeklyHours > 0 && weeklyHours < 5) add('time_efficient');
    const longSession = ctx.autoDuration || Number(ctx.durationMin) >= 90 || kind === 'block';
    if (longSession) add('fueling');
    if (Number(h.longestRideMinWin) >= 120) add('durability');
    if (kind === 'block') { add('progression'); add('taper'); add('ftp_test'); }
    if (/\b(race|racing|event|sportive|fondo|crit|criterium|time ?trial|tt|taper|tapering)\b/.test(notes)) add('taper');
    if (/\b(masters?|older|aged?|[5-8]\d ?(yo|years?))\b/.test(notes)) add('masters');
    if (/menstru|period|cycle phase|pill|contracept/.test(notes)) add('menstrual');
    return ids;
  }

  /** Compact brief for the AI prompts. */
  static brief(goal, ctx = {}, kind = 'session') {
    const m = VeloSportScience.GOAL_MODELS[goal] || VeloSportScience.GOAL_MODELS.ftp;
    const E = VeloSportScience.EVIDENCE;
    const lines = VeloSportScience.select(goal, ctx, kind).map(id => `- [${E[id].topic}; grade ${E[id].grade}] ${E[id].principle} (${E[id].refs.join('; ')})`);
    return `SPORT-SCIENCE EVIDENCE BRIEF (curated for this goal and rider, reviewed ${VeloSportScience.REVIEWED}; grade A = ${VeloSportScience.GRADES.A}, B = ${VeloSportScience.GRADES.B}, C = ${VeloSportScience.GRADES.C}):
GOAL MODEL: limited by ${m.determinants}. Intensity distribution: ${m.distribution}. Key-session menu: ${m.menu}. Progression: ${m.progression}. Avoid: ${m.avoid}.
EVIDENCE:
${lines.join('\n')}
EVIDENCE PROTOCOL: base each decision on this brief, giving grade A/B findings more weight than grade C. Where the brief is silent, use established physiology and treat it as practice-based. The rider's own data outranks population averages when they disagree. Cite only the references listed above, written exactly as shown (e.g. "${E.tid.refs[0]}"); never cite any other study.`;
  }

  /** Short JSON schema line the prompts add so the answer carries its evidence. */
  static OUTPUT_FIELD = '"evidence": [ { "principle": "short plain-language name", "why": "one plain sentence on how it shapes this plan for this rider", "ref": "one reference copied exactly from the brief" } ]';

  // ---------------------------------------------------------------- display --
  /** Canonical short citation for a reference the model returned, or '' when it is not in the evidence base. */
  static verifyRef(ref) {
    const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ø/g, 'o').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
    const want = norm(ref);
    if (!want) return '';
    for (const key of Object.keys(VeloSportScience.REFERENCES)) {
      const k = norm(key);
      // Accept "Rønnestad et al. 2020", "Ronnestad et al., 2020" and the short form inside a longer string.
      if (want === k || want.includes(k)) return key;
    }
    return '';
  }

  /** Cleans an AI-returned evidence list: plain strings, at most 5 items, unknown citations removed. */
  static sanitise(list) {
    if (!Array.isArray(list)) return [];
    const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
    return list.slice(0, 5).map(e => {
      if (!e || typeof e !== 'object') return null;
      const principle = clip(e.principle, 80);
      const why = clip(e.why, 300);
      if (!principle || !why) return null;
      const ref = VeloSportScience.verifyRef(e.ref);
      return { principle, why, ref, grade: VeloSportScience.gradeOfRef(ref) };
    }).filter(Boolean);
  }

  static gradeOfRef(ref) {
    if (!ref) return '';
    const hit = Object.values(VeloSportScience.EVIDENCE).find(e => e.refs.includes(ref));
    return hit ? hit.grade : '';
  }

  /** Evidence cards for the offline engine: the entries behind this session or block, in plain words. */
  static notesFor(goal, ctx = {}, { focus = null, kind = 'session', max = 4 } = {}) {
    const E = VeloSportScience.EVIDENCE;
    const byFocus = {
      vo2max: goal === 'longevity' ? ['longevity_crf', 'vo2_long'] : (ctx.ctl >= 25 && ctx.durationMin >= 60 ? ['vo2_long', 'vo2_short'] : ['vo2_short', 'vo2_long']),
      threshold: ['threshold'],
      sweetspot: ['threshold'],
      endurance: ['tid', 'durability'],
      recovery: ['recovery', 'tid']
    };
    const first = focus ? (byFocus[focus] || []) : [];
    const ids = [...new Set([...first, ...VeloSportScience.select(goal, ctx, kind)])]
      // A recovery day is no place for interval research.
      .filter(id => focus !== 'recovery' || !['vo2_short', 'vo2_long', 'hit_block', 'threshold'].includes(id));
    return ids.slice(0, max).map(id => ({ principle: E[id].topic, why: E[id].plain, ref: E[id].refs[0], grade: E[id].grade }));
  }

  /**
   * Position in the current mesocycle as a step 0-2 (early / middle / late), from a week's stage "n/m".
   * Recovery and test weeks return null (no progression; the session is shortened instead).
   */
  static progressionStep(week) {
    if (!week || week.type !== 'build') return null;
    const m = String(week.stage || '').match(/^(\d+)\/(\d+)$/);
    if (!m) return 1;
    const n = Number(m[1]), of = Number(m[2]);
    if (of <= 1) return 1;
    return Math.max(0, Math.min(2, Math.round(((n - 1) / (of - 1)) * 2)));
  }
}

if (typeof window !== 'undefined') window.VeloSportScience = VeloSportScience;
