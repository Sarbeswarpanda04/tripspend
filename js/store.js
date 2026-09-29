/* ============================================================
   Data layer — all Firestore access lives here.
   Documents:
     users/{uid}/trips/{tripId}
     users/{uid}/expenses/{expId}
     users/{uid}/meta/settings   (theme, homeCurrency, rates, activeTripId)
     users/{uid}/meta/cats       ({ list: [...customCategories] })
   The UI keeps in-memory arrays that are refreshed by realtime
   listeners, so multiple devices stay in sync automatically.
   ============================================================ */
const Store = (() => {
  let uid = null;
  let unsub = [];

  const U = () => db.collection('users').doc(uid);

  /* Firestore rejects `undefined`; scrub it to null / drop it. */
  const clean = obj => JSON.parse(JSON.stringify(obj));

  return {
    setUser(id) { uid = id; },
    get uid() { return uid; },

    /* Attach realtime listeners. cb(kind, data) is called on every change.
       kinds: 'trips' | 'expenses' | 'settings' | 'cats' | 'error' */
    subscribe(cb) {
      this.stop();
      unsub.push(U().collection('trips').onSnapshot(
        s => cb('trips', s.docs.map(d => ({ id: d.id, ...d.data() }))),
        err => cb('error', err)));
      unsub.push(U().collection('expenses').onSnapshot(
        s => cb('expenses', s.docs.map(d => ({ id: d.id, ...d.data() }))),
        err => cb('error', err)));
      unsub.push(U().collection('meta').doc('settings').onSnapshot(
        d => cb('settings', d.exists ? d.data() : null),
        err => cb('error', err)));
      unsub.push(U().collection('meta').doc('cats').onSnapshot(
        d => cb('cats', d.exists ? (d.data().list || []) : []),
        err => cb('error', err)));
    },

    stop() { unsub.forEach(f => { try { f(); } catch {} }); unsub = []; },

    /* ---- writes (return promises to Firestore only; no local DB fallback) ---- */
    saveTrip(t) { return U().collection('trips').doc(t.id).set(clean(t)); },
    saveExpense(e) { return U().collection('expenses').doc(e.id).set(clean(e)); },
    deleteExpense(id) { return U().collection('expenses').doc(id).delete(); },

    /* Delete a trip and every expense that belongs to it, atomically. */
    deleteTripCascade(id, expIds) {
      const batch = db.batch();
      batch.delete(U().collection('trips').doc(id));
      expIds.forEach(eid => batch.delete(U().collection('expenses').doc(eid)));
      return batch.commit();
    },

    saveSettings(patch) {
      return U().collection('meta').doc('settings').set(clean(patch), { merge: true });
    },
    saveCats(list) {
      return U().collection('meta').doc('cats').set({ list: clean(list) });
    },
  };
})();
