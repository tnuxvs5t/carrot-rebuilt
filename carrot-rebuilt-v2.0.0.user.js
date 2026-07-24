// ==UserScript==
// @name         Carrot Rebuilt
// @namespace    https://tnuxdev.site/userscripts/carrot-rebuilt
// @version      2.0.0
// @author       Yan233_ (original); reliability rewrite
// @description  Codeforces rating performance and delta columns without GM storage or monolithic standings downloads.
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
  const STATUS_PAGE_SIZE = 5000;
  const WRONG_PENALTY_ICPC_MINUTES = 20;
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
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "AbortError";
      throw new ApiRequestError(
        `${timedOut ? "Timed out" : "Network failure"} while requesting ${method}`,
        true,
        { cause: error }
      );
    } finally {
      clearTimeout(timeout);
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new ApiRequestError(
        `Non-JSON response from Codeforces API: ${method} (HTTP ${response.status})`,
        response.status === 429 || response.status >= 500,
        { cause: error }
      );
    }

    if (!response.ok || payload?.status !== "OK" || payload.result === undefined) {
      const message = payload?.comment ?? `Codeforces API request failed: ${method} (HTTP ${response.status})`;
      const retryable = response.status === 408 || response.status === 425 || response.status === 429 ||
        response.status >= 500 || /call limit exceeded|temporarily|try again|please wait|unavailable|internal error/i.test(message);
      throw new ApiRequestError(message, retryable);
    }
    return payload.result;
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
        sharedLastRequestAt = Number(localStorage.getItem(API_RATE_STORAGE_KEY)) || 0;
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
    return /rating changes.*unavailable|rating changes are unavailable|contest is not rated|not rated/i.test(message);
  }

  async function fetchRatingChanges(contestId) {
    return await fetchApi("contest.ratingChanges", { contestId });
  }

  async function fetchContest(contestId, gym) {
    const contests = await fetchApi("contest.list", { gym: String(gym) });
    const contest = contests.find((entry) => String(entry.id) === String(contestId));
    if (!contest) {
      throw new Error(`Contest ${contestId} not found`);
    }
    return contest;
  }

  async function fetchRatedUsers(contestId) {
    const users = await fetchApi("user.ratedList", {
      activeOnly: "false",
      includeRetired: "false",
      contestId
    });
    return users.map((user) => ({
      handle: user.handle,
      rating: Number.isInteger(user.rating) ? user.rating : null
    }));
  }

  async function fetchContestHacks(contestId) {
    try {
      return await fetchApi("contest.hacks", { contestId });
    } catch (error) {
      console.info(`${LOG_PREFIX} Hacks unavailable; continuing without hack adjustment.`, error);
      return [];
    }
  }

  function compareSubmissionKey(left, right) {
    return left.time === right.time ? left.id - right.id : left.time - right.time;
  }

  function isDefinitiveWrongVerdict(verdict) {
    return verdict !== undefined && verdict !== "OK" && verdict !== "COMPILATION_ERROR" &&
      verdict !== "TESTING" && verdict !== "SUBMITTED";
  }

  function getPartyKey(party) {
    if (party.participantId !== undefined) {
      return String(party.participantId);
    }
    return party.members.map((member) => member.handle).slice().sort().join(",");
  }

  function createStandingsAccumulator(contest) {
    const parties = new Map();
    const states = new Map();
    let officialSubmissionCount = 0;

    function addSubmission(submission) {
      const party = submission.author;
      const relativeTimeSeconds = submission.relativeTimeSeconds;
      if (!party || party.participantType !== "CONTESTANT" || party.ghost === true ||
          !Number.isInteger(relativeTimeSeconds) || relativeTimeSeconds < 0 ||
          relativeTimeSeconds > contest.durationSeconds) {
        return;
      }
      const problemIndex = submission.problem?.index;
      if (!problemIndex) {
        return;
      }

      officialSubmissionCount += 1;
      const partyKey = getPartyKey(party);
      parties.set(partyKey, party);
      const stateKey = `${partyKey}\u0000${problemIndex}`;
      let state = states.get(stateKey);
      if (!state) {
        state = {
          accepted: null,
          wrongs: [],
          maxPoints: Number(submission.problem?.points) || 0
        };
        states.set(stateKey, state);
      }

      const key = {
        time: Number.isInteger(submission.creationTimeSeconds)
          ? submission.creationTimeSeconds
          : relativeTimeSeconds,
        relativeTimeSeconds,
        id: Number.isInteger(submission.id) ? submission.id : 0
      };

      if (submission.verdict === "OK") {
        if (!state.accepted || compareSubmissionKey(key, state.accepted) < 0) {
          state.accepted = key;
        }
      } else if (isDefinitiveWrongVerdict(submission.verdict)) {
        state.wrongs.push(key);
      }
    }

    function finish(hacks) {
      const rowsByParty = new Map();
      for (const [partyKey, party] of parties) {
        rowsByParty.set(partyKey, { party, rank: 0, points: 0, penalty: 0 });
      }

      for (const [stateKey, state] of states) {
        if (!state.accepted) {
          continue;
        }
        const separator = stateKey.indexOf("\u0000");
        const partyKey = stateKey.slice(0, separator);
        const row = rowsByParty.get(partyKey);
        if (!row) {
          continue;
        }
        let wrongBeforeAccepted = 0;
        for (const wrong of state.wrongs) {
          if (compareSubmissionKey(wrong, state.accepted) < 0) {
            wrongBeforeAccepted += 1;
          }
        }
        const minute = Math.trunc(state.accepted.relativeTimeSeconds / 60);
        if (contest.type === "ICPC") {
          row.points += 1;
          row.penalty += minute + WRONG_PENALTY_ICPC_MINUTES * wrongBeforeAccepted;
        } else {
          const durationMinutes = contest.durationSeconds / 60;
          const timePenalty = Math.floor(120 * state.maxPoints * minute / (250 * durationMinutes));
          row.points += Math.max(
            0.3 * state.maxPoints,
            state.maxPoints - timePenalty - 50 * wrongBeforeAccepted
          );
          row.penalty += minute;
        }
      }

      const rows = Array.from(rowsByParty.values());
      applyHackScores(hacks, rows);
      rows.sort(compareRows);
      assignStandingsRanks(rows);
      return {
        contest,
        problems: [],
        rows,
        officialSubmissionCount
      };
    }

    return { addSubmission, finish };
  }

  async function rebuildContestStandings(contest, onProgress) {
    const accumulator = createStandingsAccumulator(contest);
    let from = 1;
    let pages = 0;
    let fetchedSubmissions = 0;

    for (;;) {
      const page = await fetchApi("contest.status", {
        contestId: contest.id,
        from,
        count: STATUS_PAGE_SIZE
      });
      pages += 1;
      fetchedSubmissions += page.length;
      for (const submission of page) {
        accumulator.addSubmission(submission);
      }
      onProgress?.({ pages, fetchedSubmissions, pageSize: page.length });
      if (page.length < STATUS_PAGE_SIZE) {
        break;
      }
      from += STATUS_PAGE_SIZE;
    }

    const hacks = contest.type === "CF" ? await fetchContestHacks(contest.id) : [];
    const standings = accumulator.finish(hacks);
    return {
      standings,
      statusPages: pages,
      submissions: fetchedSubmissions,
      officialSubmissions: standings.officialSubmissionCount,
      hacks: hacks.length
    };
  }

  function applyHackScores(hacks, rows) {
    const rowsByParty = new Map(rows.map((row) => [getPartyKey(row.party), row]));
    for (const hack of hacks) {
      const hacker = hack.hacker;
      if (!hacker || hacker.participantType !== "CONTESTANT" || hacker.ghost === true) {
        continue;
      }
      const key = getPartyKey(hacker);
      let row = rowsByParty.get(key);
      if (!row) {
        row = { party: hacker, rank: 0, points: 0, penalty: 0 };
        rows.push(row);
        rowsByParty.set(key, row);
      }
      if (hack.verdict === "HACK_SUCCESSFUL") {
        row.points += 100;
      } else if (hack.verdict === "HACK_UNSUCCESSFUL") {
        row.points -= 50;
      }
    }
  }

  function compareRows(left, right) {
    return left.points === right.points ? left.penalty - right.penalty : right.points - left.points;
  }

  function assignStandingsRanks(rows) {
    let rank = 0;
    let previousPoints = null;
    let previousPenalty = null;
    for (const [index, row] of rows.entries()) {
      if (row.points !== previousPoints || row.penalty !== previousPenalty) {
        rank = index + 1;
        previousPoints = row.points;
        previousPenalty = row.penalty;
      }
      row.rank = rank;
    }
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
    const contestants = entries.map(toMutableContestant);
    const seeds = buildSeeds(contestants);
    if (!ranksAreFixed) {
      assignRanks(contestants);
    }
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
    contestants.sort(
      (left, right) => left.points === right.points ? left.penalty - right.penalty : right.points - left.points
    );
    let rank = 0;
    let previousPoints = null;
    let previousPenalty = null;
    for (const [index, contestant] of contestants.entries()) {
      if (contestant.points !== previousPoints || contestant.penalty !== previousPenalty) {
        rank = index + 1;
        previousPoints = contestant.points;
        previousPenalty = contestant.penalty;
      }
      contestant.rank = rank;
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
    if (contestant.rank === 1) {
      return Infinity;
    }
    return lowerBoundInt(
      MIN_RATING,
      MAX_RATING,
      (assumedRating) => calculateDelta(contestant, assumedRating, seeds) + adjustment <= 0
    );
  }
  const EDUCATIONAL_RATED_THRESHOLD = 2100;
  const UNRATED_CONTEST_NAME_HINTS = ["unrated", "fools", "q#", "kotlin", "marathon", "teams"];
  const FAKE_RATINGS_SINCE_CONTEST = 1360;
  const NEW_DEFAULT_RATING = 1400;
  function predictFromCodeforces(standings, ratedUsers) {
    const ratings = new Map(ratedUsers.map((user) => [user.handle, user.rating]));
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
    if (isUnratedByName(standings.contest.name)) {
      return "contest-name-unrated";
    }
    if (standings.rows.some((row) => row.party.teamId !== void 0 || row.party.teamName !== void 0)) {
      return "team-contest";
    }
    if (!standings.rows.some((row) => row.party.participantType === "CONTESTANT")) {
      return "no-contestants";
    }
    return null;
  }
  function getPredictionEntries(standings, ratings, options) {
    const isEducational = isEducationalRound(standings.contest.name);
    return standings.rows.filter((row) => row.party.participantType === "CONTESTANT").filter((row) => row.party.teamId === void 0 && row.party.teamName === void 0).map((row) => {
      const handle = row.party.members[0]?.handle;
      if (!handle) {
        return null;
      }
      const rating = ratings.get(handle) ?? null;
      if (isEducational && rating !== null && rating >= EDUCATIONAL_RATED_THRESHOLD) {
        return null;
      }
      return {
        handle,
        points: row.points,
        penalty: row.penalty,
        rating
      };
    }).filter((entry) => entry !== null);
  }
  function isEducationalRound(contestName) {
    return contestName.toLowerCase().includes("educational");
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
    const rows = Array.from(table.querySelectorAll("tbody tr"));
    if (rows.length === 0) {
      return null;
    }
    return { table, rows };
  }
  function addFinalRatingColumns(standings, finalResults) {
    return addRatingColumns(standings, "Final performance", "Final rating change", "Rank change", FINAL_HEADER_CLASS, {
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
    return addRatingColumns(standings, "Predicted performance", "Predicted rating change", "Rating change for rank up", PREDICTED_HEADER_CLASS, {
      performance: (cell, row, isFooterRow) => renderPredictedPerformanceCell(cell, row, predictionMap, isFooterRow),
      delta: (cell, row, isFooterRow) => renderPredictedDeltaCell(cell, row, predictionMap, isFooterRow),
      rank: (cell, row, isFooterRow) => renderPredictedRankCell(cell, row, predictionMap, isFooterRow)
    });
  }
  function addRatingColumns(standings, performanceTitle, deltaTitle, rankTitle, headerClass, render) {
    let dataRows = 0;
    let matchedRows = 0;
    for (const [index, row] of standings.rows.entries()) {
      row.querySelector("th:last-child, td:last-child")?.classList.remove("right");
      const performanceCell = document.createElement(index === 0 ? "th" : "td");
      const deltaCell = document.createElement(index === 0 ? "th" : "td");
      const rankCell = document.createElement(index === 0 ? "th" : "td");
      performanceCell.classList.add(CELL_CLASS, PERFORMANCE_CELL_CLASS);
      deltaCell.classList.add(CELL_CLASS, DELTA_CELL_CLASS);
      rankCell.classList.add(CELL_CLASS, RANK_CELL_CLASS);
      if (index === 0) {
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
        const isFooterRow = index === standings.rows.length - 1;
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
    if (typeof performance2 !== "number") {
      cell.textContent = "N/A";
      cell.title = finalResults ? "No performance found for this row" : "Performance unavailable";
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
    if (!prediction) {
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
    return profileLink?.textContent?.trim() || null;
  }
  const PANEL_CLASS = "carrot-rebuilt-cache-panel";
  const STATUS_CLASS = "carrot-rebuilt-cache-status";
  const HIT_CLASS = "carrot-rebuilt-cache-hit";
  const MISS_CLASS = "carrot-rebuilt-cache-miss";
  const LIVE_CLASS = "carrot-rebuilt-cache-live";

  function addStatusPanel(table) {
    document.querySelector(`.${PANEL_CLASS}`)?.remove();
    const panel = document.createElement("div");
    panel.classList.add(PANEL_CLASS);

    const label = document.createElement("span");
    label.textContent = "Carrot Rebuilt";
    panel.append(label);

    const status = document.createElement("span");
    status.classList.add(STATUS_CLASS, LIVE_CLASS);
    panel.append(status);

    table.parentElement?.append(panel);
    return {
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
    const performanceByHandle = new Map(
      calculateFinalPerformanceFromRatingChanges(Number(contestId), ratingChanges)
        .map((prediction) => [prediction.handle, prediction.performance])
    );
    return new Map(
      ratingChanges.map((change) => [
        change.handle,
        {
          delta: change.newRating - change.oldRating,
          oldRating: change.oldRating,
          newRating: change.newRating,
          performance: performanceByHandle.get(change.handle)
        }
      ])
    );
  }

  async function tryRenderFinalResults(page, standings, panel, startedAt) {
    if (page.gym) {
      return false;
    }
    panel.set("checking published rating changes");
    let changes;
    try {
      changes = await fetchRatingChanges(page.contestId);
    } catch (error) {
      if (isRatingChangesUnavailable(error)) {
        return false;
      }
      console.info(`${LOG_PREFIX} Rating changes unavailable; trying live reconstruction.`, error);
      return false;
    }
    if (!Array.isArray(changes) || changes.length === 0) {
      return false;
    }

    panel.set(`computing final performance for ${changes.length} rated users`);
    const finalResults = await buildFinalResults(page.contestId, changes);
    clearCarrotColumns(standings);
    const stats = addFinalRatingColumns(standings, finalResults);
    panel.set(`final: ${stats.matchedRows}/${stats.dataRows} rows`, "ok");
    console.info(`${LOG_PREFIX} final`, {
      contestId: page.contestId,
      changes: changes.length,
      rendered: `${stats.matchedRows}/${stats.dataRows}`,
      totalMs: Math.round(performance.now() - startedAt)
    });
    return true;
  }

  async function renderPrediction(page, standings, panel, startedAt) {
    if (page.gym) {
      clearCarrotColumns(standings);
      panel.set("gym contests are not Codeforces-rated", "error");
      return;
    }

    panel.set("loading contest metadata");
    const contest = await fetchContest(page.contestId, false);
    if (isUnratedByName(contest.name)) {
      clearCarrotColumns(standings);
      panel.set("contest appears unrated", "error");
      return;
    }

    panel.set("rebuilding standings from paged submissions");
    const rebuilt = await rebuildContestStandings(contest, ({ pages, fetchedSubmissions }) => {
      panel.set(`status pages: ${pages}; submissions: ${fetchedSubmissions}`);
    });

    const skipReason = getPredictionSkipReason(rebuilt.standings);
    if (skipReason) {
      clearCarrotColumns(standings);
      panel.set(`prediction skipped: ${skipReason}`, "error");
      return;
    }

    panel.set("loading contestant ratings");
    const ratedUsers = await fetchRatedUsers(page.contestId);
    panel.set(`computing prediction for ${rebuilt.standings.rows.length} contestants`);
    const predictions = predictFromCodeforces(rebuilt.standings, ratedUsers);
    clearCarrotColumns(standings);
    const stats = addPredictedRatingColumns(standings, predictions);
    panel.set(`predicted: ${stats.matchedRows}/${stats.dataRows} rows`, "ok");
    console.info(`${LOG_PREFIX} prediction`, {
      contestId: page.contestId,
      rows: rebuilt.standings.rows.length,
      statusPages: rebuilt.statusPages,
      submissions: rebuilt.submissions,
      officialSubmissions: rebuilt.officialSubmissions,
      hacks: rebuilt.hacks,
      ratedUsers: ratedUsers.length,
      rendered: `${stats.matchedRows}/${stats.dataRows}`,
      totalMs: Math.round(performance.now() - startedAt)
    });
  }

  async function main() {
    const startedAt = performance.now();
    const page = getStandingsPage(window.location);
    if (!page) {
      return;
    }
    const standings = findStandingsTable(document);
    if (!standings) {
      console.info(`${LOG_PREFIX} Standings table not found.`);
      return;
    }

    installStandingsStyles(document);
    clearCarrotColumns(standings);
    addLoadingColumn(standings);
    const panel = addStatusPanel(standings.table);

    try {
      if (await tryRenderFinalResults(page, standings, panel, startedAt)) {
        return;
      }
      await renderPrediction(page, standings, panel, startedAt);
    } catch (error) {
      console.error(`${LOG_PREFIX} failed`, error);
      clearCarrotColumns(standings);
      addPredictedRatingColumns(standings, null);
      panel.set(error instanceof Error ? error.message : String(error), "error");
    }
  }

  void main();

})();
