const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

const VALID_ROLES = ['admin', 'teacher'];

exports.adminTeacher = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }

  const { action, idToken, ...params } = body;
  if (!idToken) return res.status(401).json({ error: 'Missing idToken' });

  const auth = admin.auth();
  const db   = admin.firestore();

  // Verify caller is admin
  let callerUid;
  try {
    const decoded = await auth.verifyIdToken(idToken);
    callerUid = decoded.uid;
    const callerDoc = await db.collection('users').doc(callerUid).get();
    if (!callerDoc.exists || callerDoc.data().role !== 'admin') {
      return res.status(403).json({ error: 'Access denied — caller is not an admin' });
    }
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token: ' + e.message });
  }

  try {
    // ── CREATE TEACHER ──
    if (action === 'createTeacher') {
      const { email, password, name, subject, assignedClasses, role } = params;
      if (!email || !password || !name) return res.status(400).json({ error: 'email, password and name are required' });
      if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
      const userRecord = await auth.createUser({ email, password, displayName: name });
      await db.collection('users').doc(userRecord.uid).set({
        name, email, subject: subject || '',
        assignedClasses: assignedClasses || [],
        role: role || 'teacher',
        createdAt: new Date().toISOString()
      });
      return res.status(200).json({ uid: userRecord.uid, message: `Teacher "${name}" created successfully` });
    }

    // ── DELETE TEACHER ──
    if (action === 'deleteTeacher') {
      const { uid } = params;
      if (!uid) return res.status(400).json({ error: 'uid is required' });
      if (uid === callerUid) return res.status(400).json({ error: 'Cannot delete your own account' });
      try { await auth.deleteUser(uid); } catch(e) { /* already deleted from Auth */ }
      await db.collection('users').doc(uid).delete();
      return res.status(200).json({ message: 'Teacher deleted from Auth and Firestore' });
    }

    // ── UPDATE PASSWORD ──
    if (action === 'updatePassword') {
      const { uid, newPassword } = params;
      if (!uid || !newPassword) return res.status(400).json({ error: 'uid and newPassword are required' });
      if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      await auth.updateUser(uid, { password: newPassword });
      return res.status(200).json({ message: 'Password updated successfully' });
    }

    // ── UPDATE TEACHER INFO ──
    if (action === 'updateTeacher') {
      const { uid, name, subject, assignedClasses, role } = params;
      if (!uid) return res.status(400).json({ error: 'uid is required' });
      if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
      if (role && uid === callerUid) return res.status(400).json({ error: 'Cannot change your own role' });
      const updateData = {};
      if (name)            { updateData.name = name; try { await auth.updateUser(uid, { displayName: name }); } catch(e) {} }
      if (subject)           updateData.subject = subject;
      if (assignedClasses)   updateData.assignedClasses = assignedClasses;
      if (role)              updateData.role = role;
      await db.collection('users').doc(uid).update(updateData);
      return res.status(200).json({ message: 'Teacher updated successfully' });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (e) {
    const msg = e.code === 'auth/email-already-exists' ? 'This email is already registered in Firebase Auth'
              : e.code === 'auth/user-not-found'       ? 'User not found in Firebase Auth'
              : e.message;
    return res.status(500).json({ error: msg });
  }
});
