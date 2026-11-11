/**
 * Variables que la app de escritorio exporta a sus procesos hijos y que rompen al CLI.
 *
 * `ACP_BACKEND=windsurf` hace que `devin` use el backend de autenticacion de Windsurf,
 * donde no existen las credenciales de Devin: `devin auth status` responde "Not logged in"
 * aunque la sesion este iniciada. En una terminal normal esa variable no existe, asi que
 * el CLI lanzado desde el puente debe ver el mismo entorno que veria el usuario.
 */
export const DEVIN_ENV_STRIP = ['ACP_BACKEND'];

export function devinEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of DEVIN_ENV_STRIP) delete env[key];
  return env;
}
