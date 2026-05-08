// User-supplied Google Drive credentials.
// REPLACE these with your own values before deploying.
window.WORSHIP_CONFIG = {
  // Drive folder ID for "Sunday guitar" parent folder
  // (open the folder in Drive, copy ID from URL: drive.google.com/drive/folders/<ID>)
  DRIVE_FOLDER_ID: "REPLACE_ME_FOLDER_ID",

  // Subfolder names inside the Sunday guitar folder
  LIB_FOLDER_NAME: "01_Lib",
  PLAYLISTS_FOLDER_NAME: "playlists",

  // Google API key (Cloud Console → Credentials → API key, restricted to Drive API)
  // Used for read-only access to the public folder
  API_KEY: "REPLACE_ME_API_KEY",

  // Google OAuth Client ID (Cloud Console → Credentials → OAuth 2.0 Client ID)
  // Used for write access (saving annotations + playlist edits)
  // Authorised origins should include: https://cowballwong.github.io
  OAUTH_CLIENT_ID: "REPLACE_ME_CLIENT_ID.apps.googleusercontent.com",
};
