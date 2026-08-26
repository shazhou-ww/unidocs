import { Page } from "../components.js";

export function LoginErrorView() {
  return (
    <Page title="Sign-in failed">
      <p>
        The Google sign-in could not be completed. Your session state did not
        match the provider response, or the identity provider rejected the
        request. Please try again.
      </p>
      <p><a href="/admin/auth/login">Start sign-in again</a></p>
    </Page>
  );
}
