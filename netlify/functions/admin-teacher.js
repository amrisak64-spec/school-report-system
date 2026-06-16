const admin = require('firebase-admin');

// Initialize Firebase Admin once (reused across warm invocations)
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const auth = admin.auth();
const db   = admin.firestore();

exports.handler = async (event) => {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action, idToken, ...params } = body;

  // Verify caller is admin
  let callerUid;
  try {
    const decoded = await auth.verifyIdToken(idToken);
    callerUid = decoded.uid;
    const callerDoc = await db.collection('users').doc(callerUid).get();
    if (!callerDoc.exists || callerDoc.data().role !== 'admin') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Access denied — not admin' }) };
    }
  } catch (e) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token' }) };
  }

  try {
    // ── CREATE TEACHER ──
    if (action === 'createTeacher') {
      const { email, password, name, subject, assignedClasses, role } = params;
      const userRecord = await auth.createUser({ email, password, displayName: name });
      await db.collection('users').doc(userRecord.uid).set({
        name, email, subject,
        assignedClasses: assignedClasses || [],
        role: role || 'teacher',
        createdAt: new Date().toISOString()
      });
      return ok({ uid: userRecord.uid, message: `Teacher "${name}" created successfully` });
    }

    // ── DELETE TEACHER ──
    if (action === 'deleteTeacher') {
      const { uid } = params;
      if (uid === callerUid) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Cannot delete your own account' }) };
      }
      await auth.deleteUser(uid);
      await db.collection('users').doc(uid).delete();
      return ok({ message: 'Teacher deleted from Auth and Firestore' });
    }

    // ── UPDATE PASSWORD ──
    if (action === 'updatePassword') {
      const { uid, newPassword } = params;
      if (!newPassword || newPassword.length < 6) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Password must be at least 6 characters' }) };
      }
      await auth.updateUser(uid, { password: newPassword });
      return ok({ message: 'Password updated successfully' });
    }

    // ── UPDATE TEACHER INFO (name, subject, classes) ──
    if (action === 'updateTeacher') {
      const { uid, name, subject, assignedClasses, role } = params;
      const updateData = {};
      if (name) { updateData.name = name; await auth.updateUser(uid, { displayName: name }); }
      if (subject)          updateData.subject = subject;
      if (assignedClasses)  updateData.assignedClasses = assignedClasses;
      if (role)             updateData.role = role;
      await db.collection('users').doc(uid).update(updateData);
      return ok({ message: 'Teacher updated successfully' });
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action: ' + action }) };

  } catch (e) {
    const msg = e.code === 'auth/email-already-exists'
      ? 'This email is already registered in Firebase Auth'
      : e.code === 'auth/user-not-found'
      ? 'User not found in Firebase Auth'
      : e.message;
    return { statusCode: 500, body: JSON.stringify({ error: msg }) };
  }
};

function ok(data) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}
