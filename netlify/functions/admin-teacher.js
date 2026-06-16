const admin = require('firebase-admin');

if (!admin.apps.length) {
  const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (svc) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(svc)) });
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return res(405, { error: 'Method not allowed' });
  }

  // Guard: service account not configured
  if (!admin.apps.length) {
    return res(503, { error: 'FIREBASE_SERVICE_ACCOUNT environment variable is not set in Netlify. Go to Netlify → Site Settings → Environment Variables and add it.' });
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return res(400, { error: 'Invalid JSON body' }); }

  const { action, idToken, ...params } = body;
  if (!idToken) return res(401, { error: 'Missing idToken' });

  const auth = admin.auth();
  const db   = admin.firestore();

  // Verify caller is admin
  let callerUid;
  try {
    const decoded = await auth.verifyIdToken(idToken);
    callerUid = decoded.uid;
    const callerDoc = await db.collection('users').doc(callerUid).get();
    if (!callerDoc.exists || callerDoc.data().role !== 'admin') {
      return res(403, { error: 'Access denied — caller is not an admin' });
    }
  } catch (e) {
    return res(401, { error: 'Invalid or expired token: ' + e.message });
  }

  try {
    // ── CREATE TEACHER ──
    if (action === 'createTeacher') {
      const { email, password, name, subject, assignedClasses, role } = params;
      if (!email || !password || !name) return res(400, { error: 'email, password and name are required' });
      const userRecord = await auth.createUser({ email, password, displayName: name });
      await db.collection('users').doc(userRecord.uid).set({
        name, email, subject: subject || '',
        assignedClasses: assignedClasses || [],
        role: role || 'teacher',
        createdAt: new Date().toISOString()
      });
      return res(200, { uid: userRecord.uid, message: `Teacher "${name}" created successfully` });
    }

    // ── DELETE TEACHER ──
    if (action === 'deleteTeacher') {
      const { uid } = params;
      if (!uid) return res(400, { error: 'uid is required' });
      if (uid === callerUid) return res(400, { error: 'Cannot delete your own account' });
      try { await auth.deleteUser(uid); } catch(e) { /* already deleted from Auth */ }
      await db.collection('users').doc(uid).delete();
      return res(200, { message: 'Teacher deleted from Auth and Firestore' });
    }

    // ── UPDATE PASSWORD ──
    if (action === 'updatePassword') {
      const { uid, newPassword } = params;
      if (!uid || !newPassword) return res(400, { error: 'uid and newPassword are required' });
      if (newPassword.length < 6) return res(400, { error: 'Password must be at least 6 characters' });
      await auth.updateUser(uid, { password: newPassword });
      return res(200, { message: 'Password updated successfully' });
    }

    // ── UPDATE TEACHER INFO ──
    if (action === 'updateTeacher') {
      const { uid, name, subject, assignedClasses, role } = params;
      if (!uid) return res(400, { error: 'uid is required' });
      const updateData = {};
      if (name)            { updateData.name = name; try { await auth.updateUser(uid, { displayName: name }); } catch(e) {} }
      if (subject)           updateData.subject = subject;
      if (assignedClasses)   updateData.assignedClasses = assignedClasses;
      if (role)              updateData.role = role;
      await db.collection('users').doc(uid).update(updateData);
      return res(200, { message: 'Teacher updated successfully' });
    }

    return res(400, { error: 'Unknown action: ' + action });

  } catch (e) {
    const msg = e.code === 'auth/email-already-exists' ? 'This email is already registered in Firebase Auth'
              : e.code === 'auth/user-not-found'       ? 'User not found in Firebase Auth'
              : e.message;
    return res(500, { error: msg });
  }
};

function res(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
