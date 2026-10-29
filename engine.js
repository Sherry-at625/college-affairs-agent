/* 学院事务咨询助手 · 检索与作答引擎
 * 纯前端、零依赖。规则：边界守卫 → 资料外守卫 → 意图匹配（条款级） → 关键词兜底 → 固定兜底话术
 * 同时可在 Node 中 require 后用于批量测试（挂到 globalThis.AgentEngine）。
 */
(function (root) {
  'use strict';

  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[\s\u3000]/g, '')
      .replace(/[，。！？、；：""''（）《》【】\[\]（）()?!.,;:~`@#$%^&*\-_+=|\/\\<>]/g, '');
  }

  function hasAny(nq, arr) {
    for (var i = 0; i < arr.length; i++) {
      if (nq.indexOf(norm(arr[i])) !== -1) return arr[i];
    }
    return null;
  }

  function allGroupsHit(nq, groups) {
    for (var i = 0; i < groups.length; i++) {
      if (!hasAny(nq, groups[i])) return false;
    }
    return true;
  }

  // 条款级检索打分（用于「命中依据前 3 名」展示，也用于兜底检索）
  function scoreChunks(nq, kb) {
    var out = [];
    for (var i = 0; i < kb.chunks.length; i++) {
      var c = kb.chunks[i], score = 0, hitWords = [];
      for (var j = 0; j < c.keywords.length; j++) {
        var kw = norm(c.keywords[j]);
        if (!kw) continue;
        if (nq.indexOf(kw) !== -1) {
          score += Math.min(kw.length, 6);
          hitWords.push(c.keywords[j]);
        }
      }
      // FAQ 降权：正式文件优先于 FAQ
      if (c.id.charAt(0) === 'F') score = score * 0.6;
      out.push({ id: c.id, doc: c.doc, docShort: c.docShort, clause: c.clause, text: c.text, score: score, hitWords: hitWords });
    }
    out.sort(function (a, b) { return b.score - a.score || (a.id > b.id ? 1 : -1); });
    return out;
  }

  function chunkById(kb, id) {
    for (var i = 0; i < kb.chunks.length; i++) if (kb.chunks[i].id === id) return kb.chunks[i];
    return null;
  }

  function evidenceOf(kb, ids, scoreMap) {
    var ev = [];
    for (var i = 0; i < ids.length; i++) {
      var c = chunkById(kb, ids[i]);
      if (c) ev.push({
        id: c.id, doc: c.doc, docShort: c.docShort, clause: c.clause, text: c.text,
        score: scoreMap && scoreMap[c.id] != null ? scoreMap[c.id] : 0
      });
    }
    return ev;
  }

  function toScoreMap(ranked) {
    var m = {};
    for (var i = 0; i < ranked.length; i++) m[ranked[i].id] = ranked[i].score;
    return m;
  }

  function answer(q, kb) {
    var nq = norm(q);
    if (!nq) {
      return {
        type: 'empty', typeLabel: '空输入',
        conclusion: '请描述你要咨询的具体问题，例如"补考申请要在多久内提交"。',
        evidence: [], next: '本助手覆盖补考、缓考、重修、成绩复核、奖助学金、宿舍与教室报修六大类事务。',
        top3: []
      };
    }

    var ranked = scoreChunks(nq, kb);
    var top3 = ranked.slice(0, 3);
    var scoreMap = toScoreMap(ranked);

    // ---------- 1. 边界守卫（优先级最高） ----------
    var g = kb.guards;
    var gOrder = ['medical', 'invest', 'discipline', 'offtopic', 'ghostwrite'];
    for (var i = 0; i < gOrder.length; i++) {
      var key = gOrder[i], rule = g[key];
      if (!rule) continue;
      var hit = hasAny(nq, rule.patterns);
      if (hit && rule.require && !allGroupsHit(nq, rule.require)) hit = null;
      if (hit) {
        return {
          type: 'guard', typeLabel: '越界 / 服务范围外',
          conclusion: rule.conclusion,
          evidence: [{ doc: '服务范围说明', clause: '边界规则', text: rule.evidence }],
          next: rule.next,
          top3: top3, matched: hit
        };
      }
    }

    // ---------- 2. 资料外问题：走固定兜底话术（不推测） ----------
    var ooc = kb.outOfCorpus || [];
    for (var k = 0; k < ooc.length; k++) {
      var oh = hasAny(nq, ooc[k].patterns);
      if (oh) {
        return {
          type: 'fallback', typeLabel: '资料未收录',
          conclusion: kb.fallback.conclusion,
          evidence: [{ doc: '检索结论', clause: '—', text: kb.fallback.evidence }],
          next: ooc[k].next,
          top3: top3, matched: oh
        };
      }
    }

    // ---------- 3. 意图匹配（条款级，按优先级取第一个满足的） ----------
    var list = kb.intents.slice().sort(function (a, b) { return b.priority - a.priority; });
    for (var m = 0; m < list.length; m++) {
      if (allGroupsHit(nq, list[m].require)) {
        var ev = evidenceOf(kb, list[m].chunks, scoreMap);
        return {
          type: 'answer', typeLabel: '命中依据',
          intent: list[m].id,
          conclusion: list[m].conclusion,
          evidence: ev,
          next: list[m].next,
          top3: ev.concat(top3.filter(function (c) { return list[m].chunks.indexOf(c.id) === -1; })).slice(0, 3)
        };
      }
    }

    // ---------- 4. 关键词兜底检索：够强就答，不够就走固定兜底 ----------
    if (top3.length && top3[0].score >= 8) {
      var best = top3[0];
      var c = chunkById(kb, best.id);
      return {
        type: 'answer', typeLabel: '检索命中（兜底检索）',
        intent: 'generic',
        conclusion: c.text.length > 60 ? c.text.slice(0, 58) + '……' : c.text,
        evidence: [c],
        next: '如需办理，请按上述条款到对应部门办理；有疑问可拨教务处 0411-0000-0003。',
        top3: top3
      };
    }

    return {
      type: 'fallback', typeLabel: '资料未收录',
      conclusion: kb.fallback.conclusion,
      evidence: [{ doc: '检索结论', clause: '—', text: kb.fallback.evidence }],
      next: kb.fallback.next,
      top3: top3
    };
  }

  root.AgentEngine = { answer: answer, norm: norm, scoreChunks: scoreChunks };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.AgentEngine;
})(typeof window !== 'undefined' ? window : globalThis);
