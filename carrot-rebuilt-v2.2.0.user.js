// ==UserScript==
// @name         Carrot Rebuilt
// @namespace    https://tnuxdev.site/userscripts/carrot-rebuilt
// @version      2.2.0
// @author       Yan233_ (original); reliability rewrite
// @description  Codeforces live rating and performance prediction from current public standings; official final deltas, automatic refresh.
// @license      AGPL-3.0-or-later
// @match        https://codeforces.com/contest/*/standings*
// @match        https://codeforces.com/gym/*/standings*
// @grant        none
// @sandbox      raw
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const LOG_PREFIX = "[Carrot Rebuilt]";
  const API_ROOT = "https://codeforces.com/api/";
  const API_MIN_INTERVAL_MS = 2100;
  const API_TIMEOUT_MS = 30000;
  const API_MAX_ATTEMPTS = 3;
  const API_LOCK_NAME = "carrot-rebuilt-codeforces-api";
  const API_RATE_STORAGE_KEY = "carrot-rebuilt.api.last-request-at";
  const REFRESH_INTERVAL_MS = 60000;
  const RATING_CACHE_MS = 5 * 60000;
  const MAX_PENDING_RATING_AGE_SECONDS = 3 * 86400;
  let ratingCache = null;
  let apiQueue = Promise.resolve();
  let localLastApiRequestAt = 0;

  class ApiRequestError extends Error {
    constructor(message, retryable = false, options) {
      super(message, options);
      this.name = "ApiRequestError";
      this.retryable = retryable;
    }
  }

  async function fetchApi(method, query = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= API_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await scheduleApiRequest(() => fetchApiOnce(method, query));
      } catch (error) {
        lastError = error;
        if (!(error instanceof ApiRequestError) || !error.retryable || attempt === API_MAX_ATTEMPTS) {
          throw error;
        }
        await sleep(700 * 2 ** (attempt - 1));
      }
    }
    throw lastError ?? new Error(`Codeforces API request failed: ${method}`);
  }

  async function fetchApiOnce(method, query) {
    const url = new URL(method, API_ROOT);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        // Public CF API methods are anonymous, even on a logged-in standings page.
        credentials: "omit",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      // Keep the deadline active until the response body has been consumed.
      const payload = await response.json();
      if (!response.ok || payload?.status !== "OK" || payload.result === undefined) {
        const message = payload?.comment ?? ("Codeforces API request failed: " + method + " (HTTP " + response.status + ")");
        const retryable = !isRatingChangesUnavailable(message) && (
          [408, 425, 429].includes(response.status) || response.status >= 500 ||
          /call limit exceeded|temporarily|try again|please wait|unavailable|internal error/i.test(message)
        );
        throw new ApiRequestError(message, retryable);
      }
      return payload.result;
    } catch (error) {
      if (error instanceof ApiRequestError) throw error;
      if (controller.signal.aborted || error?.name === "AbortError") {
        throw new ApiRequestError("Timed out while requesting " + method, true, { cause: error });
      }
      if (error?.name === "SyntaxError") {
        const status = response?.status;
        throw new ApiRequestError(
          "Non-JSON response from Codeforces API: " + method + " (HTTP " + status + "). Open Codeforces and complete any verification, then refresh.",
          [408, 425, 429].includes(status) || status >= 500,
          { cause: error }
        );
      }
      throw new ApiRequestError("Network failure while requesting " + method, true, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  function scheduleApiRequest(task) {
    const scheduled = apiQueue.then(() => withCrossTabApiLock(task));
    apiQueue = scheduled.catch(() => undefined);
    return scheduled;
  }

  async function withCrossTabApiLock(task) {
    const execute = async () => {
      let sharedLastRequestAt = 0;
      try {
        const stored = Number(localStorage.getItem(API_RATE_STORAGE_KEY));
        sharedLastRequestAt = Number.isFinite(stored) ? Math.min(Date.now(), Math.max(0, stored)) : 0;
      } catch {
        sharedLastRequestAt = 0;
      }
      const earliest = Math.max(localLastApiRequestAt, sharedLastRequestAt) + API_MIN_INTERVAL_MS;
      const delay = earliest - Date.now();
      if (delay > 0) {
        await sleep(delay);
      }
      const requestAt = Date.now();
      localLastApiRequestAt = requestAt;
      try {
        localStorage.setItem(API_RATE_STORAGE_KEY, String(requestAt));
      } catch {
      }
      return await task();
    };

    if (navigator.locks?.request) {
      return await navigator.locks.request(API_LOCK_NAME, execute);
    }
    return await execute();
  }

  function sleep(durationMs) {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
  }

  function isRatingChangesUnavailable(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /rating changes.*unavailable|contest is not rated|not rated|contest.*(?:has not finished|not finished|not over)/i.test(message);
  }

  async function fetchRatingChanges(contestId) {
    return await fetchApi("contest.ratingChanges", { contestId });
  }

  async function fetchContestStandings(contestId) {
    // As of the 2026 public API, regular contests REQUIRE an anonymous GET with
    // exactly one query parameter: contestId. Any extra parameter (including
    // showUnofficial=false) rejects an otherwise valid standings request.
    // Do not paginate: changing ranks between pages can create duplicates/gaps.
    const standings = await fetchApi("contest.standings", { contestId });
    if (!standings?.contest || !Array.isArray(standings.rows) ||
        String(standings.contest.id) !== String(contestId)) {
      throw new Error("Invalid contest standings response");
    }
    return standings;
  }

  async function fetchRatedUsers(contestId) {
    if (ratingCache?.contestId === contestId && Date.now() - ratingCache.fetchedAt < RATING_CACHE_MS) {
      return ratingCache.users;
    }
    const result = await fetchApi("user.ratedList", {
      activeOnly: "false", includeRetired: "true", contestId
    });
    if (!Array.isArray(result)) throw new Error("Invalid rated users response");
    const users = result
      .filter((user) => typeof user?.handle === "string" && user.handle.length > 0)
      .map((user) => ({
        handle: user.handle,
        rating: Number.isInteger(user.rating) ? user.rating : null
      }));
    ratingCache = { contestId, fetchedAt: Date.now(), users };
    return users;
  }

  function normalizeHandle(handle) {
    return String(handle).trim().toLowerCase();
  }

  const STANDINGS_PATH_PATTERN = /^\/(contest|gym)\/(\d+)\/standings(?:\/.*)?$/;
  function getStandingsPage(location) {
    const match = STANDINGS_PATH_PATTERN.exec(location.pathname);
    if (!match) {
      return null;
    }
    return {
      contestId: match[2],
      gym: match[1] === "gym"
    };
  }
  function lowerBoundInt(start, end, matches) {
    let left = start;
    let right = end;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (matches(middle)) {
        right = middle;
      } else {
        left = middle + 1;
      }
    }
    return left;
  }
  class RealConvolution {
    size;
    reverseIndex;
    rootReal;
    rootImaginary;
    constructor(requiredSize) {
      let bits = 1;
      while (2 ** bits < requiredSize) {
        bits += 1;
      }
      this.size = 2 ** bits;
      const reverseIndex = new Array(this.size);
      reverseIndex[0] = 0;
      for (let index = 1; index < this.size; index += 1) {
        reverseIndex[index] = reverseIndex[index >> 1] >> 1 | (index & 1) << bits - 1;
      }
      this.reverseIndex = reverseIndex;
      const half = this.size / 2;
      const angleStep = 2 * Math.PI / this.size;
      this.rootReal = Array.from({ length: half }, (_, index) => Math.cos(index * angleStep));
      this.rootImaginary = Array.from({ length: half }, (_, index) => Math.sin(index * angleStep));
    }
    convolve(left, right) {
      if (left.length === 0 || right.length === 0) {
        return [];
      }
      const resultLength = left.length + right.length - 1;
      if (resultLength > this.size) {
        throw new Error(`Convolution result length ${resultLength} exceeds FFT size ${this.size}`);
      }
      const real = new Array(this.size).fill(0);
      const imaginary = new Array(this.size).fill(0);
      for (let index = 0; index < left.length; index += 1) {
        real[index] = left[index];
      }
      for (let index = 0; index < right.length; index += 1) {
        imaginary[index] = right[index];
      }
      this.transform(real, imaginary);
      real[0] = 4 * real[0] * imaginary[0];
      imaginary[0] = 0;
      for (let index = 1, mirror = this.size - 1; index <= mirror; index += 1, mirror -= 1) {
        const leftReal = real[index] + real[mirror];
        const leftImaginary = imaginary[index] - imaginary[mirror];
        const rightReal = imaginary[mirror] + imaginary[index];
        const rightImaginary = real[mirror] - real[index];
        real[index] = leftReal * rightReal - leftImaginary * rightImaginary;
        imaginary[index] = leftReal * rightImaginary + leftImaginary * rightReal;
        real[mirror] = real[index];
        imaginary[mirror] = -imaginary[index];
      }
      this.transform(real, imaginary);
      const result = new Array(resultLength);
      result[0] = real[0] / (4 * this.size);
      for (let index = 1, mirror = this.size - 1; index <= mirror && index < resultLength; index += 1, mirror -= 1) {
        result[index] = real[mirror] / (4 * this.size);
        if (mirror < resultLength) {
          result[mirror] = real[index] / (4 * this.size);
        }
      }
      return result;
    }
    transform(real, imaginary) {
      this.applyBitReverse(real);
      this.applyBitReverse(imaginary);
      for (let block = 2; block <= this.size; block *= 2) {
        const halfBlock = block / 2;
        const step = this.size / block;
        for (let offset = 0; offset < this.size; offset += block) {
          let rootIndex = 0;
          for (let index = offset; index < offset + halfBlock; index += 1) {
            const pair = index + halfBlock;
            const rotatedReal = real[pair] * this.rootReal[rootIndex] - imaginary[pair] * this.rootImaginary[rootIndex];
            const rotatedImaginary = real[pair] * this.rootImaginary[rootIndex] + imaginary[pair] * this.rootReal[rootIndex];
            real[pair] = real[index] - rotatedReal;
            imaginary[pair] = imaginary[index] - rotatedImaginary;
            real[index] += rotatedReal;
            imaginary[index] += rotatedImaginary;
            rootIndex += step;
          }
        }
      }
    }
    applyBitReverse(values) {
      for (let index = 1; index < this.size; index += 1) {
        const mirror = this.reverseIndex[index];
        if (index < mirror) {
          const current = values[index];
          values[index] = values[mirror];
          values[mirror] = current;
        }
      }
    }
  }
  const DEFAULT_RATING = 1400;
  const MIN_RATING = -500;
  const MAX_RATING = 6e3;
  const RATING_SPAN = MAX_RATING - MIN_RATING;
  const RATING_INDEX_OFFSET = -MIN_RATING;
  const WIN_PROBABILITY_OFFSET = RATING_SPAN;
  const winProbability = Array.from(
    { length: 2 * RATING_SPAN + 1 },
    (_, index) => 1 / (1 + 10 ** ((index - WIN_PROBABILITY_OFFSET) / 400))
  );
  const convolution = new RealConvolution(winProbability.length + RATING_SPAN - 1);
  function predictDeltas(entries, ranksAreFixed = false) {
    if (entries.length === 0) return [];
    const contestants = entries.map(toMutableContestant);
    const handles = new Set();
    for (const contestant of contestants) {
      if (!contestant.handle || handles.has(contestant.handle)) throw new Error("Duplicate or missing contestant handle");
      handles.add(contestant.handle);
      if (!Number.isInteger(contestant.effectiveRating) || contestant.effectiveRating < MIN_RATING || contestant.effectiveRating >= MAX_RATING) {
        throw new Error("Contestant rating outside supported calculation range");
      }
      if (ranksAreFixed ? contestant.rank < 1 : !Number.isFinite(contestant.points) || !Number.isFinite(contestant.penalty)) {
        throw new Error("Invalid contestant score or rank");
      }
    }
    const seeds = buildSeeds(contestants);
    if (ranksAreFixed) assignPublishedRanks(contestants);
    else assignRanks(contestants);
    calculate(contestants, seeds);
    return toPredictions(contestants);
  }
  function calculate(contestants, seeds) {
    for (const contestant of contestants) {
      contestant.delta = calculateDelta(contestant, contestant.effectiveRating, seeds);
    }
    const adjustment = adjustDeltas(contestants);
    for (const contestant of contestants) {
      contestant.performance = calculatePerformance(contestant, seeds, adjustment);
    }
  }
  function toPredictions(contestants) {
    return contestants.map(({ handle, rating, delta, performance: performance2 }) => ({
      handle,
      rating,
      delta,
      performance: performance2
    }));
  }
  function toMutableContestant(entry) {
    return {
      ...entry,
      handle: normalizeHandle(entry.handle ?? ""),
      effectiveRating: entry.rating ?? DEFAULT_RATING,
      rank: Number.isInteger(entry.rank) && entry.rank > 0 ? entry.rank : 0,
      delta: 0,
      performance: 0
    };
  }
  function buildSeeds(contestants) {
    const ratingCounts = new Array(RATING_SPAN).fill(0);
    for (const contestant of contestants) {
      ratingCounts[contestant.effectiveRating + RATING_INDEX_OFFSET] += 1;
    }
    const seeds = convolution.convolve(winProbability, ratingCounts);
    for (let index = 0; index < seeds.length; index += 1) {
      seeds[index] = seeds[index] + 1;
    }
    return seeds;
  }
  function seedForRating(rating, excludedRating, seeds) {
    return seeds[rating + WIN_PROBABILITY_OFFSET + RATING_INDEX_OFFSET] - winProbability[rating - excludedRating + WIN_PROBABILITY_OFFSET];
  }
  function assignRanks(contestants) {
    contestants.sort((left, right) =>
      left.points === right.points ? left.penalty - right.penalty : right.points - left.points);
    // The rating algorithm uses the last place in a tied group, not the first.
    let rank = 0;
    let previousPoints;
    let previousPenalty;
    for (let index = contestants.length - 1; index >= 0; index -= 1) {
      const contestant = contestants[index];
      if (contestant.points !== previousPoints || contestant.penalty !== previousPenalty) {
        rank = index + 1;
        previousPoints = contestant.points;
        previousPenalty = contestant.penalty;
      }
      contestant.rank = rank;
    }
  }
  function assignPublishedRanks(contestants) {
    contestants.sort((left, right) => left.rank - right.rank);
    let previousRank;
    let rank = 0;
    for (let index = contestants.length - 1; index >= 0; index -= 1) {
      const publishedRank = contestants[index].rank;
      if (publishedRank !== previousRank) {
        rank = index + 1;
        previousRank = publishedRank;
      }
      contestants[index].rank = rank;
    }
  }
  function calculateDelta(contestant, assumedRating, seeds) {
    const seed = seedForRating(assumedRating, contestant.effectiveRating, seeds);
    const targetRank = Math.sqrt(contestant.rank * seed);
    const ratingNeeded = ratingForRank(targetRank, contestant.effectiveRating, seeds);
    return Math.trunc((ratingNeeded - assumedRating) / 2);
  }
  function ratingForRank(rank, ownRating, seeds) {
    return lowerBoundInt(2, MAX_RATING, (rating) => seedForRating(rating, ownRating, seeds) < rank) - 1;
  }
  function adjustDeltas(contestants) {
    contestants.sort((left, right) => right.effectiveRating - left.effectiveRating);
    const totalDelta = contestants.reduce((sum, contestant) => sum + contestant.delta, 0);
    const primaryAdjustment = Math.trunc(-totalDelta / contestants.length) - 1;
    for (const contestant of contestants) {
      contestant.delta += primaryAdjustment;
    }
    const leaderCount = Math.min(4 * Math.round(Math.sqrt(contestants.length)), contestants.length);
    const leaderDelta = contestants.slice(0, leaderCount).reduce((sum, contestant) => sum + contestant.delta, 0);
    const leaderAdjustment = Math.min(Math.max(Math.trunc(-leaderDelta / leaderCount), -10), 0);
    for (const contestant of contestants) {
      contestant.delta += leaderAdjustment;
    }
    return primaryAdjustment + leaderAdjustment;
  }
  function calculatePerformance(contestant, seeds, adjustment) {
    // The highest unique place has no finite break-even performance rating.
    if (contestant.rank === 1) return Infinity;
    const result = lowerBoundInt(
      MIN_RATING,
      MAX_RATING,
      (assumedRating) => calculateDelta(contestant, assumedRating, seeds) + adjustment <= 0
    );
    // Reaching MAX_RATING means our bounded inversion did not find a root.
    // Do not incorrectly label that case as an exact 6000 performance.
    return result === MAX_RATING ? null : result;
  }
  const EDUCATIONAL_RATED_THRESHOLD = 2100;
  // These are common rating ceilings, not a substitute for contest-specific
  // eligibility/anti-cheat rules. Only apply them for unambiguous round names.
  function getRatedRatingCeiling(contestName) {
    const name = contestName.toLowerCase();
    const divisions = [...name.matchAll(/div(?:ision)?\.?\s*([1-4])\b/g)]
      .map((match) => Number(match[1]));
    if (name.includes("educational")) return EDUCATIONAL_RATED_THRESHOLD;
    if (new Set(divisions).size !== 1) return null;
    switch (divisions[0]) {
      case 2: return 2100;
      case 3: return 1600;
      case 4: return 1400;
      default: return null;
    }
  }
  const UNRATED_CONTEST_NAME_HINTS = ["unrated", "fools", "q#", "kotlin", "marathon", "teams"];
  const FAKE_RATINGS_SINCE_CONTEST = 1360;
  const NEW_DEFAULT_RATING = 1400;
  function predictFromCodeforces(standings, ratedUsers) {
    const ratings = new Map(ratedUsers.map((user) => [normalizeHandle(user.handle), user.rating]));
    const entries = getPredictionEntries(standings, ratings);
    return predictDeltas(entries);
  }
  function calculateFinalPerformanceFromRatingChanges(contestId, ratingChanges) {
    const entries = ratingChanges.map((change) => ({
      handle: change.handle,
      rating: contestId >= FAKE_RATINGS_SINCE_CONTEST && change.oldRating === 0
        ? NEW_DEFAULT_RATING
        : change.oldRating,
      rank: change.rank
    }));
    return predictDeltas(entries, true);
  }
  function getPredictionSkipReason(standings) {
    if (!["CF", "ICPC"].includes(standings.contest.type)) return "unsupported-contest-type";
    if (standings.contest.frozen) return "standings-frozen";
    const contestEnd = standings.contest.startTimeSeconds + standings.contest.durationSeconds;
    if (standings.contest.phase === "FINISHED" && Date.now() / 1000 - contestEnd > MAX_PENDING_RATING_AGE_SECONDS) {
      return "published-rating-unavailable-for-old-contest";
    }
    if (isUnratedByName(standings.contest.name)) {
      return "contest-name-unrated";
    }
    if (standings.rows.length && standings.rows.every((row) =>
      row.party?.teamId !== undefined || row.party?.teamName !== undefined ||
      (row.party?.members?.length ?? 0) !== 1)) {
      return "team-contest";
    }
    if (!standings.rows.some((row) => row.party.participantType === "CONTESTANT")) {
      return "no-contestants";
    }
    return null;
  }
  function getPredictionEntries(standings, ratings) {
    const ceiling = getRatedRatingCeiling(standings.contest.name);
    const contestId = Number(standings.contest.id);
    const seen = new Set();
    const entries = [];
    for (const row of standings.rows) {
      const party = row.party;
      if (party?.participantType !== "CONTESTANT" || party.ghost ||
          party.teamId !== undefined || party.teamName !== undefined ||
          party.members?.length !== 1) continue;
      const handle = party.members[0]?.handle;
      if (typeof handle !== "string" || !handle) continue;
      const normalized = normalizeHandle(handle);
      if (seen.has(normalized)) {
        throw new Error("Duplicate contestant in official standings: " + handle);
      }
      seen.add(normalized);
      const previousRating = ratings.get(normalized) ?? null;
      // New accounts can appear as rating=0 before a first rated round.
      // Since CF contest #1360, their effective initial rating is 1400.
      const rating = contestId >= FAKE_RATINGS_SINCE_CONTEST && previousRating === 0
        ? null : previousRating;
      if (ceiling !== null && (rating ?? DEFAULT_RATING) >= ceiling) continue;
      if (!Number.isFinite(row.points) || !Number.isFinite(row.penalty)) continue;
      entries.push({ handle, points: row.points, penalty: row.penalty, rating });
    }
    return entries;
  }
  function isUnratedByName(contestName) {
    const lowerName = contestName.toLowerCase();
    return UNRATED_CONTEST_NAME_HINTS.some((hint) => lowerName.includes(hint));
  }
  const UNRATED_RANK = {
    name: "Unrated",
    abbr: "U",
    low: -Infinity,
    high: Infinity,
    colorClass: null
  };
  const RATED_RANKS = [
    { name: "Newbie", abbr: "N", low: -Infinity, high: 1200, colorClass: "user-gray" },
    { name: "Pupil", abbr: "P", low: 1200, high: 1400, colorClass: "user-green" },
    { name: "Specialist", abbr: "S", low: 1400, high: 1600, colorClass: "user-cyan" },
    { name: "Expert", abbr: "E", low: 1600, high: 1900, colorClass: "user-blue" },
    { name: "Candidate Master", abbr: "CM", low: 1900, high: 2100, colorClass: "user-violet" },
    { name: "Master", abbr: "M", low: 2100, high: 2300, colorClass: "user-orange" },
    { name: "International Master", abbr: "IM", low: 2300, high: 2400, colorClass: "user-orange" },
    { name: "Grandmaster", abbr: "GM", low: 2400, high: 2600, colorClass: "user-red" },
    { name: "International Grandmaster", abbr: "IGM", low: 2600, high: 3e3, colorClass: "user-red" },
    { name: "Legendary Grandmaster", abbr: "LGM", low: 3e3, high: 4e3, colorClass: "user-legendary" },
    { name: "Tourist", abbr: "T", low: 4e3, high: Infinity, colorClass: "user-4000" }
  ];
  function getRank(rating) {
    if (rating === null) {
      return UNRATED_RANK;
    }
    return RATED_RANKS.find((rank) => rating < rank.high) ?? RATED_RANKS[RATED_RANKS.length - 1];
  }
  function getNextRank(rank) {
    const index = RATED_RANKS.indexOf(rank);
    return index >= 0 ? RATED_RANKS[index + 1] ?? null : RATED_RANKS[0];
  }
  const CELL_CLASS = "carrot-rebuilt-cell";
  const HEADER_CLASS = "carrot-rebuilt-header";
  const PERFORMANCE_CELL_CLASS = "carrot-rebuilt-performance-cell";
  const DELTA_CELL_CLASS = "carrot-rebuilt-delta-cell";
  const RANK_CELL_CLASS = "carrot-rebuilt-rank-cell";
  const RANK_HELPER_CLASS = "carrot-rebuilt-rank-helper";
  const RANK_UP_ACHIEVED_CLASS = "carrot-rebuilt-rank-up-achieved";
  const FINAL_HEADER_CLASS = "carrot-rebuilt-header-final";
  const LOADING_HEADER_CLASS = "carrot-rebuilt-header-loading";
  const PREDICTED_HEADER_CLASS = "carrot-rebuilt-header-predicted";
  function findStandingsTable(document2) {
    const table = document2.querySelector("table.standings");
    if (!table) {
      return null;
    }
    const rows = Array.from(table.rows).filter((row) => row.closest("table") === table);
    if (rows.length === 0) {
      return null;
    }
    return { table, rows };
  }
  function addFinalRatingColumns(standings, finalResults) {
    return addRatingColumns(standings, "Estimated performance from published rating ranks", "Official final rating change", "Official rank change", FINAL_HEADER_CLASS, {
      performance: (cell, row, isFooterRow) => renderFinalPerformanceCell(cell, row, finalResults, isFooterRow),
      delta: (cell, row, isFooterRow) => renderFinalDeltaCell(cell, row, finalResults, isFooterRow),
      rank: (cell, row, isFooterRow) => renderFinalRankCell(cell, row, finalResults, isFooterRow)
    });
  }
  function addLoadingColumn(standings) {
    return addRatingColumns(standings, "Loading performance", "Loading rating changes", "Loading rank data", LOADING_HEADER_CLASS, {
      performance: (cell, _row, isFooterRow) => renderLoadingCell(cell, isFooterRow),
      delta: (cell, _row, isFooterRow) => renderLoadingCell(cell, isFooterRow),
      rank: (cell, _row, isFooterRow) => renderLoadingCell(cell, isFooterRow)
    });
  }
  function renderLoadingCell(cell, isFooterRow) {
    cell.textContent = isFooterRow ? "" : "…";
    if (!isFooterRow) {
      cell.classList.add("carrot-rebuilt-muted");
    }
    return !isFooterRow;
  }
  function clearCarrotColumns(standings) {
    for (const row of standings.rows) {
      row.querySelectorAll(`.${CELL_CLASS}`).forEach((cell) => cell.remove());
      row.querySelector("th:last-child, td:last-child")?.classList.add("right");
    }
  }
  function addPredictedRatingColumns(standings, predictions) {
    const predictionMap = predictions ? new Map(predictions.map((prediction) => [prediction.handle, prediction])) : null;
    return addRatingColumns(standings, "Estimated performance (break-even rating, live standings)", "Estimated rating change if the contest is rated", "Rating change required for rank up", PREDICTED_HEADER_CLASS, {
      performance: (cell, row, isFooterRow) => renderPredictedPerformanceCell(cell, row, predictionMap, isFooterRow),
      delta: (cell, row, isFooterRow) => renderPredictedDeltaCell(cell, row, predictionMap, isFooterRow),
      rank: (cell, row, isFooterRow) => renderPredictedRankCell(cell, row, predictionMap, isFooterRow)
    });
  }
  function addRatingColumns(standings, performanceTitle, deltaTitle, rankTitle, headerClass, render) {
    let dataRows = 0;
    let matchedRows = 0;
    for (const [index, row] of standings.rows.entries()) {
      const isContestantRow = Boolean(row.querySelector("td.contestant-cell"));
      const isHeaderRow = !isContestantRow && (index === 0 || Boolean(row.querySelector("th")));
      row.querySelector("th:last-child, td:last-child")?.classList.remove("right");
      const performanceCell = document.createElement(isHeaderRow ? "th" : "td");
      const deltaCell = document.createElement(isHeaderRow ? "th" : "td");
      const rankCell = document.createElement(isHeaderRow ? "th" : "td");
      performanceCell.classList.add(CELL_CLASS, PERFORMANCE_CELL_CLASS);
      deltaCell.classList.add(CELL_CLASS, DELTA_CELL_CLASS);
      rankCell.classList.add(CELL_CLASS, RANK_CELL_CLASS);
      if (isHeaderRow) {
        performanceCell.classList.add("top", HEADER_CLASS, headerClass);
        performanceCell.title = performanceTitle;
        performanceCell.textContent = "Π";
        deltaCell.classList.add("top", HEADER_CLASS, headerClass);
        deltaCell.title = deltaTitle;
        deltaCell.textContent = "Δ";
        rankCell.classList.add("top", "right", HEADER_CLASS, headerClass);
        rankCell.title = rankTitle;
        rankCell.textContent = "Rank";
      } else {
        rankCell.classList.add("right");
        if (index % 2) {
          performanceCell.classList.add("dark");
          deltaCell.classList.add("dark");
          rankCell.classList.add("dark");
        }
        const isFooterRow = !isContestantRow;
        if (!isFooterRow) {
          dataRows += 1;
        }
        const hasPerformance = render.performance(performanceCell, row, isFooterRow);
        const hasDelta = render.delta(deltaCell, row, isFooterRow);
        const hasRank = render.rank(rankCell, row, isFooterRow);
        if (hasPerformance || hasDelta || hasRank) {
          matchedRows += 1;
        }
      }
      row.append(performanceCell, deltaCell, rankCell);
    }
    return { matchedRows, dataRows };
  }
  function renderFinalDeltaCell(cell, row, finalResults, isFooterRow) {
    if (isFooterRow) {
      cell.textContent = "";
      return false;
    }
    const handle = getHandle(row);
    const delta = handle && finalResults?.get(handle)?.delta;
    if (typeof delta !== "number") {
      cell.textContent = "N/A";
      cell.title = finalResults ? "No rating change found for this row" : "Rating changes unavailable";
      cell.classList.add("carrot-rebuilt-muted");
      return false;
    }
    renderDeltaText(cell, delta);
    return true;
  }
  function renderFinalPerformanceCell(cell, row, finalResults, isFooterRow) {
    if (isFooterRow) {
      cell.textContent = "";
      return false;
    }
    const handle = getHandle(row);
    const performance2 = handle && finalResults?.get(handle)?.performance;
    if (!Number.isFinite(performance2) && performance2 !== Infinity) {
      cell.textContent = "N/A";
      cell.title = finalResults ? "No bounded performance estimate found for this row" : "Performance unavailable";
      cell.classList.add("carrot-rebuilt-muted");
      return false;
    }
    renderPerformance(cell, performance2);
    return true;
  }
  function renderFinalRankCell(cell, row, finalResults, isFooterRow) {
    if (isFooterRow) {
      cell.textContent = "";
      return false;
    }
    const handle = getHandle(row);
    const result = handle ? finalResults?.get(handle) : void 0;
    if (!result) {
      cell.textContent = "N/A";
      cell.title = finalResults ? "No rank change found for this row" : "Rank change unavailable";
      cell.classList.add("carrot-rebuilt-muted");
      return false;
    }
    const oldRank = getRank(result.oldRating);
    const newRank = getRank(result.newRating);
    if (oldRank.abbr === newRank.abbr) {
      cell.textContent = "—";
      cell.title = "No rank change";
      cell.classList.add("carrot-rebuilt-muted");
      return true;
    }
    const arrow = result.delta > 0 ? "↑" : "↓";
    appendRankHelper(cell, [makeRankSpan(oldRank), makeArrowSpan(arrow), makeRankSpan(newRank)]);
    return true;
  }
  function renderPredictedDeltaCell(cell, row, predictions, isFooterRow) {
    if (isFooterRow) {
      cell.textContent = "";
      return false;
    }
    const handle = getHandle(row);
    const prediction = handle ? predictions?.get(handle) : void 0;
    if (!prediction) {
      cell.textContent = "N/A";
      cell.title = predictions ? "No prediction found for this row" : "Prediction unavailable";
      cell.classList.add("carrot-rebuilt-muted");
      return false;
    }
    renderDeltaText(cell, prediction.delta);
    return true;
  }
  function renderPredictedPerformanceCell(cell, row, predictions, isFooterRow) {
    if (isFooterRow) {
      cell.textContent = "";
      return false;
    }
    const handle = getHandle(row);
    const prediction = handle ? predictions?.get(handle) : void 0;
    if (!prediction || (prediction.performance !== Infinity && !Number.isFinite(prediction.performance))) {
      cell.textContent = "N/A";
      cell.title = predictions ? "No prediction found for this row" : "Prediction unavailable";
      cell.classList.add("carrot-rebuilt-muted");
      return false;
    }
    renderPerformance(cell, prediction.performance);
    return true;
  }
  function renderPredictedRankCell(cell, row, predictions, isFooterRow) {
    if (isFooterRow) {
      cell.textContent = "";
      return false;
    }
    const handle = getHandle(row);
    const prediction = handle ? predictions?.get(handle) : void 0;
    if (!prediction) {
      cell.textContent = "N/A";
      cell.title = predictions ? "No prediction found for this row" : "Prediction unavailable";
      cell.classList.add("carrot-rebuilt-muted");
      return false;
    }
    const rank = getRank(prediction.rating);
    const effectiveRating = prediction.rating ?? 1400;
    const effectiveRank = getRank(effectiveRating);
    const nextRank = getNextRank(effectiveRank);
    if (!nextRank) {
      appendRankHelper(cell, [makeRankSpan(rank)]);
      return true;
    }
    appendRankHelper(cell, [
      makeDeltaSpan(effectiveRank.high - effectiveRating),
      makeArrowSpan("↑"),
      makeRankSpan(nextRank)
    ]);
    if (prediction.delta >= effectiveRank.high - effectiveRating) {
      cell.classList.add(RANK_UP_ACHIEVED_CLASS);
    }
    return true;
  }
  function renderPerformance(cell, performance2) {
    cell.textContent = performance2 === Infinity ? "∞" : String(performance2);
    cell.title = performance2 === Infinity
      ? "Unbounded first-place performance (conventional Carrot definition)"
      : "Estimated break-even performance rating (zero predicted rating change)";
    cell.classList.add("carrot-rebuilt-performance");
    const colorClass = performance2 === Infinity ? null : getRank(performance2).colorClass;
    if (colorClass) {
      cell.classList.add(colorClass);
    }
  }
  function renderDeltaText(cell, delta) {
    cell.textContent = formatDelta(delta);
    cell.classList.add(delta > 0 ? "carrot-rebuilt-positive" : "carrot-rebuilt-negative");
  }
  function appendRankHelper(cell, children) {
    const span = document.createElement("span");
    span.classList.add(RANK_HELPER_CLASS);
    span.append(...children);
    cell.append(span);
  }
  function makeDeltaSpan(delta) {
    const span = document.createElement("span");
    span.textContent = formatDelta(delta);
    span.classList.add("carrot-rebuilt-rank-delta", delta > 0 ? "carrot-rebuilt-positive" : "carrot-rebuilt-negative");
    return span;
  }
  function makeRankSpan(rank) {
    const span = document.createElement("span");
    span.textContent = rank.abbr;
    span.title = rank.name;
    span.classList.add("carrot-rebuilt-rank-abbr");
    if (rank.colorClass) {
      span.classList.add(rank.colorClass);
    }
    return span;
  }
  function makeArrowSpan(arrow) {
    const span = document.createElement("span");
    span.textContent = arrow;
    span.classList.add("carrot-rebuilt-rank-arrow");
    return span;
  }
  function formatDelta(delta) {
    return delta > 0 ? `+${delta}` : String(delta);
  }
  function getHandle(row) {
    const contestantCell = row.querySelector("td.contestant-cell");
    const profileLink = contestantCell?.querySelector('a[href*="/profile/"]');
    // The URL is stable even if Codeforces decorates the visible handle.
    const href = profileLink?.getAttribute("href");
    const match = href && /\/profile\/([^/?#]+)/.exec(href);
    if (match) {
      try { return normalizeHandle(decodeURIComponent(match[1])); } catch { /* fall back to visible text */ }
    }
    return profileLink?.textContent?.trim() ? normalizeHandle(profileLink.textContent) : null;
  }
  const PANEL_CLASS = "carrot-rebuilt-cache-panel";
  const STATUS_CLASS = "carrot-rebuilt-cache-status";
  const HIT_CLASS = "carrot-rebuilt-cache-hit";
  const MISS_CLASS = "carrot-rebuilt-cache-miss";
  const LIVE_CLASS = "carrot-rebuilt-cache-live";

  function addStatusPanel(table, refresh) {
    document.querySelector(`.${PANEL_CLASS}`)?.remove();
    const panel = document.createElement("div");
    panel.classList.add(PANEL_CLASS);

    const label = document.createElement("span");
    label.textContent = "Carrot Rebuilt";
    panel.append(label);

    const status = document.createElement("span");
    status.classList.add(STATUS_CLASS, LIVE_CLASS);
    panel.append(status);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Refresh";
    button.classList.add("carrot-rebuilt-cache-clear");
    button.addEventListener("click", refresh);
    panel.append(button);
    table.parentElement?.append(panel);
    return {
      element: panel,
      setBusy(busy) { button.disabled = busy; },
      set(text, tone = "live") {
        status.textContent = text;
        status.classList.remove(HIT_CLASS, MISS_CLASS, LIVE_CLASS);
        status.classList.add(tone === "ok" ? HIT_CLASS : tone === "error" ? MISS_CLASS : LIVE_CLASS);
      }
    };
  }

  function installStandingsStyles(document2) {
    if (document2.getElementById("carrot-rebuilt-styles")) {
      return;
    }
    const style = document2.createElement("style");
    style.id = "carrot-rebuilt-styles";
    style.textContent = `
.carrot-rebuilt-cell {
  width: 4em;
  min-width: 4em;
  text-align: center;
}

.carrot-rebuilt-rank-cell {
  width: 6.5em;
  min-width: 6.5em;
}

.carrot-rebuilt-rank-up-achieved {
  background-color: #f2fff2;
}

.carrot-rebuilt-rank-up-achieved.dark {
  background-color: #ebf8eb;
}

tr.highlighted-row .carrot-rebuilt-rank-up-achieved {
  background-color: #d1eef2 !important;
}

.carrot-rebuilt-header {
  font-weight: bold;
}

.carrot-rebuilt-header-final {
  color: green;
}

.carrot-rebuilt-header-loading {
  color: #9aa0a6;
  text-decoration-line: underline;
  text-decoration-thickness: 2px;
  text-decoration-color: #c4c7cc;
  text-underline-offset: 0.16em;
}

.carrot-rebuilt-header-predicted {
  color: #9b6a00;
}

.carrot-rebuilt-positive {
  color: green;
  font-weight: bold;
}

.carrot-rebuilt-negative {
  color: gray;
  font-weight: bold;
}

.carrot-rebuilt-muted {
  color: lightgray;
  font-weight: bold;
}

.carrot-rebuilt-performance {
  font-weight: bold;
}

.carrot-rebuilt-rank-helper {
  align-items: center;
  display: inline-flex;
  font-weight: bold;
}

.carrot-rebuilt-rank-delta {
  line-height: 1;
}

.carrot-rebuilt-rank-abbr {
  display: inline-block;
  line-height: 1;
}

.carrot-rebuilt-rank-arrow {
  line-height: 1;
  padding-left: 0.5em;
  padding-right: 0.5em;
}

.carrot-rebuilt-cache-panel {
  align-items: center;
  background: rgba(255, 255, 255, 0.82);
  border: 1px solid #dddddd;
  border-radius: 4px;
  bottom: 0.6em;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  color: #777;
  display: inline-flex;
  font-size: 0.92em;
  gap: 0.45em;
  max-width: calc(100vw - 1.2em);
  overflow-x: auto;
  padding: 0.35em 0.45em;
  position: fixed;
  right: 0.6em;
  white-space: nowrap;
  z-index: 20;
}

.carrot-rebuilt-cache-status {
  border: 1px solid #d8d8d8;
  border-radius: 999px;
  padding: 0.12em 0.55em;
  white-space: nowrap;
}

.carrot-rebuilt-cache-hit {
  border-color: #9dcc9d;
  color: green;
}

.carrot-rebuilt-cache-miss {
  border-color: #d4c090;
  color: #9b6a00;
}

.carrot-rebuilt-cache-live {
  border-color: #b9c7d8;
  color: #536f8a;
}

.carrot-rebuilt-cache-clear {
  background: #f7f7f7;
  border: 1px solid #cfcfcf;
  border-radius: 3px;
  color: #555;
  cursor: pointer;
  font: inherit;
  padding: 0.12em 0.55em;
}

.carrot-rebuilt-cache-clear:hover {
  background: #eeeeee;
}
`;
    document2.head.append(style);
  }
  async function buildFinalResults(contestId, ratingChanges) {
    let performanceByHandle = new Map();
    let performanceError = null;
    try {
      performanceByHandle = new Map(
        calculateFinalPerformanceFromRatingChanges(Number(contestId), ratingChanges)
          .map((prediction) => [normalizeHandle(prediction.handle), prediction.performance])
      );
    } catch (error) {
      // An estimate failing must not hide the official rating changes.
      performanceError = error;
      console.warn(LOG_PREFIX, "Performance estimation failed", error);
    }
    const results = new Map(ratingChanges.map((change) => [normalizeHandle(change.handle), {
      delta: change.newRating - change.oldRating,
      oldRating: change.oldRating,
      newRating: change.newRating,
      performance: performanceByHandle.get(normalizeHandle(change.handle))
    }]));
    return { results, performanceError };
  }

  async function loadView(page, setStatus) {
    if (page.gym) return { kind: "skipped", message: "gym contests are not Codeforces-rated" };
    setStatus("checking published rating changes");
    let changes;
    try {
      changes = await fetchRatingChanges(page.contestId);
    } catch (error) {
      // Only an explicit absence of rating changes allows prediction fallback.
      if (!isRatingChangesUnavailable(error)) throw error;
    }
    if (changes !== undefined && !Array.isArray(changes)) throw new Error("Invalid rating changes response");
    if (changes?.length) {
      if (changes.some((change) => !change.handle || !Number.isInteger(change.oldRating) ||
          !Number.isInteger(change.newRating) || !Number.isInteger(change.rank) || change.rank < 1)) {
        throw new Error("Invalid published rating change");
      }
      setStatus("computing performance for " + changes.length + " rated users");
      const { results, performanceError } = await buildFinalResults(page.contestId, changes);
      return { kind: "final", results, performanceError, fetchedAt: Date.now() };
    }
    setStatus("loading official standings");
    const standings = await fetchContestStandings(page.contestId);
    const skipReason = getPredictionSkipReason(standings);
    if (skipReason) return {
      kind: "skipped", message: "prediction skipped: " + skipReason,
      refreshable: ["no-contestants", "standings-frozen"].includes(skipReason)
    };
    setStatus("loading contestant ratings");
    const users = await fetchRatedUsers(page.contestId);
    const predictions = predictFromCodeforces(standings, users);
    if (predictions.length === 0) return { kind: "skipped", message: "no eligible contestants", refreshable: true };
    return { kind: "predicted", predictions, fetchedAt: Date.now() };
  }

  function start() {
    const page = getStandingsPage(window.location);
    if (!page) return;
    installStandingsStyles(document);
    let standings = null;
    let handles = [];
    let panel = null;
    let view = null;
    let busy = false;
    let timer = null;
    let scheduledMount = null;
    let stopped = false;
    let statusText = "waiting for standings";
    let statusTone = "live";

    function setStatus(text, tone = "live") {
      statusText = text;
      statusTone = tone;
      panel?.set(text, tone);
    }
    function render() {
      if (!standings?.table.isConnected) return null;
      clearCarrotColumns(standings);
      if (view?.kind === "final") return addFinalRatingColumns(standings, view.results);
      if (view?.kind === "predicted") return addPredictedRatingColumns(standings, view.predictions);
      if (view?.kind === "skipped") return null;
      if (view?.kind === "error") return addPredictedRatingColumns(standings, null);
      return addLoadingColumn(standings);
    }
    function describeView(stats) {
      if (view.kind === "skipped") return setStatus(view.message, "error");
      const time = new Date(view.fetchedAt).toLocaleTimeString();
      const coverage = stats ? stats.matchedRows + "/" + stats.dataRows + " rows" : "table unavailable";
      if (view.kind === "final") {
        setStatus("final Δ; " + (view.performanceError ? "performance unavailable" : "estimated Π") + "; " + coverage + "; " + time,
          view.performanceError ? "error" : "ok");
      } else {
        setStatus("live predicted Π/Δ (unofficial); " + coverage + "; " + time);
      }
    }
    function scheduleRefresh() {
      clearTimeout(timer);
      timer = null;
      if (!stopped && !document.hidden && view?.kind !== "final" &&
          !(view?.kind === "skipped" && !view.refreshable) && !page.gym) {
        timer = setTimeout(() => { void refresh(); }, REFRESH_INTERVAL_MS);
      }
    }
    async function refresh(manual = false) {
      if (stopped || busy || !standings || (!manual && document.hidden)) return;
      clearTimeout(timer);
      busy = true;
      panel?.setBusy(true);
      if (manual) ratingCache = null;
      try {
        const nextView = await loadView(page, setStatus);
        if (stopped) return;
        view = nextView;
        describeView(render());
      } catch (error) {
        if (stopped) return;
        console.error(LOG_PREFIX, error);
        const hasPrevious = view?.kind === "final" || view?.kind === "predicted";
        const previousTime = hasPrevious ? new Date(view.fetchedAt).toLocaleTimeString() : "";
        if (!hasPrevious) { view = { kind: "error" }; render(); }
        setStatus((hasPrevious ? "stale results from " + previousTime + "; " : "") + (error instanceof Error ? error.message : String(error)), "error");
      } finally {
        busy = false;
        panel?.setBusy(false);
        scheduleRefresh();
      }
    }
    function mount() {
      if (stopped) return;
      const currentPage = getStandingsPage(window.location);
      if (!currentPage || currentPage.contestId !== page.contestId || currentPage.gym !== page.gym) {
        stop();
        return;
      }
      const next = findStandingsTable(document);
      if (!next) return;
      const nextHandles = next.rows.map(getHandle);
      const changed = !standings || standings.table !== next.table ||
        standings.rows.length !== next.rows.length ||
        next.rows.some((row, index) => row !== standings.rows[index] || nextHandles[index] !== handles[index]) ||
        next.rows.some((row) => row.querySelector("td.contestant-cell") && view?.kind !== "skipped" &&
          !row.querySelector("." + PERFORMANCE_CELL_CLASS));
      const firstMount = standings === null;
      standings = next;
      handles = nextHandles;
      if (!panel?.element.isConnected) {
        panel = addStatusPanel(next.table, () => { void refresh(true); });
        panel.set(statusText, statusTone);
        panel.setBusy(busy);
      }
      if (changed) {
        const stats = render();
        if (!busy && (view?.kind === "final" || view?.kind === "predicted") && statusTone !== "error") {
          describeView(stats);
        }
      }
      if (firstMount) void refresh();
    }
    const observer = new MutationObserver((records) => {
      // Ignore our own cells/panel to avoid a render-observe-render feedback loop.
      if (!records.some((record) => {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (target?.closest?.("." + CELL_CLASS + ", ." + PANEL_CLASS)) return false;
        if (record.type === "attributes") return true;
        return [...record.addedNodes, ...record.removedNodes].some((node) =>
          node.nodeType === 1 && !node.classList.contains(CELL_CLASS) && !node.classList.contains(PANEL_CLASS));
      })) return;
      clearTimeout(scheduledMount);
      scheduledMount = setTimeout(mount, 100);
    });
    function onVisibilityChange() {
      if (document.hidden) { clearTimeout(timer); timer = null; }
      else {
        mount();
        if (!busy && view?.kind !== "final") void refresh();
      }
    }
    function stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(scheduledMount);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", (event) => { if (!event.persisted) stop(); });
    mount();
  }

  start();

})();