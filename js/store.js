/* ============================================================
   Data layer — all Firestore access lives here.
   Owner data:
     users/{ownerUid}/trips/{tripId}
     users/{ownerUid}/expenses/{expenseId}
   Shared trip memberships:
     users/{uid}/joinedTrips/{ownerUid}_{tripId}
     tripShares/{ownerUid}/trips/{tripId}/members/{uid}
   Invitations:
     tripInvites/{inviteId}
   ============================================================ */
const Store = (() => {
  let uid = null;
  let callback = null;
  let unsub = [];
  let joinedUnsub = [];
  let joinedTripUnsub = new Map();
  let ownTrips = [];
  let ownExpenses = [];
  let sharedTrips = new Map();
  let sharedExpenses = new Map();
  let readyState = null;

  const U = () => db.collection('users').doc(uid);
  const ownerUser = ownerUid => db.collection('users').doc(ownerUid);
  const shareKey = (ownerUid, tripId) => `${ownerUid}_${tripId}`;
  const shareMembers = (ownerUid, tripId) => db.collection('tripShares').doc(ownerUid)
    .collection('trips').doc(tripId).collection('members');

  const clean = obj => JSON.parse(JSON.stringify(obj));
  const emit = (kind, data) => { if(callback) callback(kind, data); };
  const emitTrips = () => emit('trips', ownTrips.concat(...sharedTrips.values()));
  const emitExpenses = () => emit('expenses', ownExpenses.concat(...sharedExpenses.values()));
  const markReady = key => {
    if(!readyState || readyState.sent) return;
    readyState[key]=true;
    if(readyState.trips && readyState.expenses && readyState.settings && readyState.catalog){
      readyState.sent=true;
      emit('ready');
    }
  };

  function stopJoinedListeners(){
    joinedUnsub.forEach(stop=>stop());
    joinedUnsub=[];
    joinedTripUnsub.forEach(listeners=>listeners.forEach(stop=>stop()));
    joinedTripUnsub.clear();
    sharedTrips.clear();
    sharedExpenses.clear();
  }

  function watchJoinedTrips(snapshot){
    const current = new Map();
    snapshot.docs.forEach(doc=>{
      const membership=doc.data();
      if(membership.ownerUid && membership.tripId){
        current.set(doc.id, membership);
      } else {
        emit('error', new Error(`Invalid joined trip record: ${doc.id}`));
      }
    });

    joinedTripUnsub.forEach((listeners,key)=>{
      if(!current.has(key)){
        listeners.forEach(stop=>stop());
        joinedTripUnsub.delete(key);
        sharedTrips.delete(key);
        sharedExpenses.delete(key);
      }
    });

    current.forEach((membership,key)=>{
      if(joinedTripUnsub.has(key)) return;
      const {ownerUid,tripId}=membership;
      const owner=ownerUser(ownerUid);
      const listeners=[];
      listeners.push(owner.collection('trips').doc(tripId).onSnapshot(
        doc=>{
          if(doc.exists){
            sharedTrips.set(key,{id:doc.id,...doc.data(),ownerUid});
          } else {
            sharedTrips.delete(key);
          }
          emitTrips();
        },
        error=>emit('error',error)));
      listeners.push(owner.collection('expenses').where('tripId','==',tripId).onSnapshot(
        docs=>{
          sharedExpenses.set(key,docs.docs.map(doc=>({id:doc.id,...doc.data(),ownerUid})));
          emitExpenses();
        },
        error=>emit('error',error)));
      joinedTripUnsub.set(key,listeners);
    });

    emitTrips();
    emitExpenses();
  }

  return {
    setUser(id) { uid = id; },
    get uid() { return uid; },

    subscribe(cb) {
      this.stop();
      callback=cb;
      readyState={trips:false,expenses:false,settings:false,catalog:false,sent:false};
      unsub.push(db.collection('appConfig').doc('catalog').onSnapshot(
        snapshot=>{
          if(!snapshot.exists){
            emit('error',{source:'catalog',error:new Error('Firestore appConfig/catalog does not exist.')});
            return;
          }
          emit('catalog',snapshot.data());
          markReady('catalog');
        },
        error=>emit('error',{source:'catalog',error})));
      unsub.push(U().collection('trips').onSnapshot(
        snapshot=>{
          ownTrips=snapshot.docs.map(doc=>({id:doc.id,...doc.data(),ownerUid:uid}));
          emitTrips();
          markReady('trips');
        },
        error=>emit('error',{source:'trips',error})));
      unsub.push(U().collection('expenses').onSnapshot(
        snapshot=>{
          ownExpenses=snapshot.docs.map(doc=>({id:doc.id,...doc.data(),ownerUid:uid}));
          emitExpenses();
          markReady('expenses');
        },
        error=>emit('error',{source:'expenses',error})));
      unsub.push(U().collection('meta').doc('settings').onSnapshot(
        doc=>{
          emit('settings',doc.exists?doc.data():null);
          markReady('settings');
        },
        error=>emit('error',{source:'settings',error})));
      unsub.push(U().collection('meta').doc('cats').onSnapshot(
        doc=>emit('cats',doc.exists?(doc.data().list||[]):[]),
        error=>emit('error',error)));
      unsub.push(db.collection('userDirectory').doc(uid).onSnapshot(
        doc=>emit('discoverable',doc.exists?doc.data():null),
        error=>emit('error',error)));
      unsub.push(db.collection('collaborationInvites')
        .where('inviteeUid','==',uid).limit(20).onSnapshot(
          snapshot=>emit('collaborationInvites',snapshot.docs
            .map(doc=>({id:doc.id,...doc.data()}))
            .filter(invite=>invite.status==='pending')),
          error=>emit('error',error)));
      joinedUnsub.push(U().collection('joinedTrips').onSnapshot(
        watchJoinedTrips,
        error=>emit('error',error)));
    },

    stop() {
      unsub.forEach(stop=>stop());
      unsub=[];
      stopJoinedListeners();
      joinedUnsub.forEach(stop=>stop());
      joinedUnsub=[];
      callback=null;
      readyState=null;
      ownTrips=[];
      ownExpenses=[];
    },

    saveTrip(trip) {
      const ownerUid=trip.ownerUid||uid;
      return ownerUser(ownerUid).collection('trips').doc(trip.id)
        .set(clean({...trip,ownerUid}));
    },
    saveExpense(expense) {
      const ownerUid=expense.ownerUid||uid;
      return ownerUser(ownerUid).collection('expenses').doc(expense.id)
        .set(clean({...expense,ownerUid}));
    },
    deleteExpense(id,ownerUid=uid) {
      return ownerUser(ownerUid).collection('expenses').doc(id).delete();
    },

    async deleteTripCascade(id,ownerUid=uid,inviteId=null) {
      const owner=ownerUser(ownerUid);
      const [expenseSnapshot,memberSnapshot]=await Promise.all([
        owner.collection('expenses').where('tripId','==',id).get(),
        shareMembers(ownerUid,id).get()
      ]);

      const collaborationDocs=[];
      let cursor=null;
      while(true){
        let query=db.collection('collaborationInvites')
          .where('ownerUid','==',ownerUid)
          .orderBy(firebase.firestore.FieldPath.documentId())
          .limit(450);
        if(cursor) query=query.startAfter(cursor);
        const page=await query.get();
        collaborationDocs.push(...page.docs.filter(doc=>doc.data().tripId===id));
        if(page.size<450) break;
        cursor=page.docs[page.docs.length-1];
      }

      const inviteByMember=new Map(collaborationDocs.map(doc=>[doc.data().inviteeUid,doc]));
      for(let offset=0;offset<memberSnapshot.docs.length;offset+=5){
        const members=memberSnapshot.docs.slice(offset,offset+5);
        const joinedSnapshots=await Promise.all(members.map(member=>
          ownerUser(member.id).collection('joinedTrips').doc(shareKey(ownerUid,id)).get()));
        const batch=db.batch();
        for(let index=0;index<members.length;index++){
          const member=members[index];
          batch.delete(member.ref);
          if(joinedSnapshots[index].exists){
            batch.delete(joinedSnapshots[index].ref);
          }
          const invite=inviteByMember.get(member.id);
          if(invite){
            batch.delete(invite.ref);
            inviteByMember.delete(member.id);
          }
        }
        await batch.commit();
      }

      const deleteRefs=[
        ...expenseSnapshot.docs.map(doc=>doc.ref)
      ];
      for(let offset=0;offset<deleteRefs.length;offset+=450){
        const deleteBatch=db.batch();
        deleteRefs.slice(offset,offset+450).forEach(ref=>deleteBatch.delete(ref));
        await deleteBatch.commit();
      }

      const tripInviteRef=inviteId&&ownerUid===uid
        ? db.collection('tripInvites').doc(inviteId)
        : null;
      const tripInviteExists=tripInviteRef&&(await tripInviteRef.get()).exists;
      const finalBatch=db.batch();
      finalBatch.delete(owner.collection('trips').doc(id));
      if(tripInviteExists) finalBatch.delete(tripInviteRef);
      const pendingInviteRefs=collaborationDocs
        .filter(doc=>inviteByMember.has(doc.data().inviteeUid))
        .map(doc=>doc.ref);
      pendingInviteRefs.slice(0,5).forEach(ref=>finalBatch.delete(ref));
      await finalBatch.commit();
      for(let offset=5;offset<pendingInviteRefs.length;offset+=450){
        const inviteBatch=db.batch();
        pendingInviteRefs.slice(offset,offset+450).forEach(ref=>inviteBatch.delete(ref));
        await inviteBatch.commit();
      }
    },

    createTripInvite(trip) {
      const ownerUid=trip.ownerUid||uid;
      const ownerTrip=ownerUser(ownerUid).collection('trips').doc(trip.id);
      const inviteRef=db.collection('tripInvites').doc();
      return db.runTransaction(async transaction=>{
        const tripDoc=await transaction.get(ownerTrip);
        if(!tripDoc.exists) throw new Error('This trip no longer exists.');
        const existingId=tripDoc.data().inviteId;
        if(existingId){
          const existingInvite=await transaction.get(db.collection('tripInvites').doc(existingId));
          if(existingInvite.exists && existingInvite.data().active===true) return existingId;
        }
        transaction.set(inviteRef,{
          ownerUid,
          tripId:trip.id,
          tripName:trip.name,
          active:true,
          createdAt:firebase.firestore.FieldValue.serverTimestamp()
        });
        transaction.update(ownerTrip,{inviteId:inviteRef.id});
        return inviteRef.id;
      });
    },

    revokeTripInvite(trip) {
      const ownerUid=trip.ownerUid||uid;
      const ownerTrip=ownerUser(ownerUid).collection('trips').doc(trip.id);
      const inviteRef=db.collection('tripInvites').doc(trip.inviteId);
      return db.runTransaction(async transaction=>{
        const tripDoc=await transaction.get(ownerTrip);
        if(!tripDoc.exists || tripDoc.data().inviteId!==trip.inviteId) return;
        const inviteDoc=await transaction.get(inviteRef);
        if(inviteDoc.exists && inviteDoc.data().active===true){
          transaction.update(inviteRef,{active:false});
        }
        transaction.update(ownerTrip,{inviteId:null});
      });
    },

    acceptTripInvite(inviteId) {
      const inviteRef=db.collection('tripInvites').doc(inviteId);
      return db.runTransaction(async transaction=>{
        const inviteDoc=await transaction.get(inviteRef);
        if(!inviteDoc.exists || inviteDoc.data().active!==true){
          throw new Error('This invite link is invalid or has been revoked.');
        }
        const invite=inviteDoc.data();
        const {ownerUid,tripId}=invite;
        if(!ownerUid || !tripId) throw new Error('This invite link is invalid.');
        if(ownerUid===uid) return {ownerUid,tripId,tripName:invite.tripName};

        const key=shareKey(ownerUid,tripId);
        const memberRef=shareMembers(ownerUid,tripId).doc(uid);
        const joinedRef=U().collection('joinedTrips').doc(key);
        const [memberDoc,joinedDoc]=await Promise.all([
          transaction.get(memberRef),
          transaction.get(joinedRef)
        ]);
        const membership={
          ownerUid,
          tripId,
          inviteId,
          joinedAt:firebase.firestore.FieldValue.serverTimestamp(),
          displayName:firebase.auth().currentUser?.displayName||'Trip traveler',
          photoURL:firebase.auth().currentUser?.photoURL||null
        };
        if(!memberDoc.exists) transaction.set(memberRef,{uid,...membership});
        if(!joinedDoc.exists) transaction.set(joinedRef,membership);
        return {ownerUid,tripId,tripName:invite.tripName};
      });
    },

    setDiscoverable(discoverable, displayName, photoURL) {
      const profileRef=db.collection('userDirectory').doc(uid);
      if(!discoverable) return profileRef.delete();
      const name=(displayName||'').trim();
      if(!name) return Promise.reject(new Error('Your Google profile needs a display name to be searchable.'));
      return profileRef.set({
        uid,
        displayName:name,
        searchName:name.toLocaleLowerCase(),
        photoURL:photoURL||null,
        updatedAt:firebase.firestore.FieldValue.serverTimestamp()
      });
    },

    searchUsers(term) {
      const prefix=(term||'').trim().toLocaleLowerCase();
      if(prefix.length<2) return Promise.resolve([]);
      return db.collection('userDirectory')
        .orderBy('searchName')
        .startAt(prefix)
        .endAt(prefix+'\uf8ff')
        .limit(10)
        .get()
        .then(snapshot=>snapshot.docs
          .map(doc=>doc.data())
          .filter(profile=>profile.uid!==uid));
    },

    sendCollaborationInvite(trip, inviteeUid, ownerName) {
      const inviteRef=db.collection('collaborationInvites')
        .doc(`${uid}_${trip.id}_${inviteeUid}`);
      const profileRef=db.collection('userDirectory').doc(inviteeUid);
      const memberRef=shareMembers(uid,trip.id).doc(inviteeUid);
      return db.runTransaction(async transaction=>{
        const [profileDoc,memberDoc,inviteDoc]=await Promise.all([
          transaction.get(profileRef),
          transaction.get(memberRef),
          transaction.get(inviteRef)
        ]);
        if(memberDoc.exists) return {alreadyMember:true};
        if(inviteDoc.exists) return {alreadyInvited:true};
        if(!profileDoc.exists) throw new Error('This user is no longer available for collaboration.');
        transaction.set(inviteRef,{
          ownerUid:uid,
          ownerName:(ownerName||'').trim(),
          inviteeUid,
          tripId:trip.id,
          tripName:trip.name,
          createdAt:firebase.firestore.FieldValue.serverTimestamp(),
          status:'pending'
        });
        return {sent:true};
      });
    },

    acceptCollaborationInvite(inviteId) {
      const inviteRef=db.collection('collaborationInvites').doc(inviteId);
      return db.runTransaction(async transaction=>{
        const inviteDoc=await transaction.get(inviteRef);
        if(!inviteDoc.exists || inviteDoc.data().status!=='pending' || inviteDoc.data().inviteeUid!==uid){
          throw new Error('This collaboration invite is no longer available.');
        }
        const invite=inviteDoc.data();
        const key=shareKey(invite.ownerUid,invite.tripId);
        const memberRef=shareMembers(invite.ownerUid,invite.tripId).doc(uid);
        const joinedRef=U().collection('joinedTrips').doc(key);
        const [memberDoc,joinedDoc]=await Promise.all([
          transaction.get(memberRef),
          transaction.get(joinedRef)
        ]);
        if(memberDoc.exists || joinedDoc.exists){
          if(memberDoc.exists && joinedDoc.exists){
            transaction.update(inviteRef,{
              status:'accepted',
              respondedAt:firebase.firestore.FieldValue.serverTimestamp()
            });
          }
          return {alreadyMember:true,ownerUid:invite.ownerUid,tripId:invite.tripId,tripName:invite.tripName};
        }
        const membership={
          ownerUid:invite.ownerUid,
          tripId:invite.tripId,
          inviteId,
          joinedAt:firebase.firestore.FieldValue.serverTimestamp(),
          displayName:firebase.auth().currentUser?.displayName||'Trip traveler',
          photoURL:firebase.auth().currentUser?.photoURL||null
        };
        transaction.update(inviteRef,{
          status:'accepted',
          respondedAt:firebase.firestore.FieldValue.serverTimestamp()
        });
        transaction.set(memberRef,{uid,...membership});
        transaction.set(joinedRef,membership);
        return {ownerUid:invite.ownerUid,tripId:invite.tripId,tripName:invite.tripName};
      });
    },

    getTripMembers(ownerUid, tripId) {
      return shareMembers(ownerUid,tripId).get()
        .then(snapshot=>snapshot.docs.map(doc=>({uid:doc.id,...doc.data()})));
    },

    removeTripMember(ownerUid, tripId, memberUid) {
      const memberRef=shareMembers(ownerUid,tripId).doc(memberUid);
      const joinedRef=ownerUser(memberUid).collection('joinedTrips').doc(shareKey(ownerUid,tripId));
      const inviteRef=db.collection('collaborationInvites').doc(`${ownerUid}_${tripId}_${memberUid}`);
      return db.runTransaction(async transaction=>{
        const [memberDoc,joinedDoc,inviteDoc]=await Promise.all([
          transaction.get(memberRef),
          transaction.get(joinedRef),
          transaction.get(inviteRef)
        ]);
        if(!memberDoc.exists && !joinedDoc.exists) return false;
        if(memberDoc.exists) transaction.delete(memberRef);
        if(joinedDoc.exists) transaction.delete(joinedRef);
        if(inviteDoc.exists) transaction.delete(inviteRef);
        return true;
      });
    },

    saveSettings(patch) {
      return U().collection('meta').doc('settings').set(clean(patch),{merge:true});
    },
    saveCats(list) {
      return U().collection('meta').doc('cats').set({list:clean(list)});
    },
  };
})();
