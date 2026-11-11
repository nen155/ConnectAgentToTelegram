import { matchProject, type DesktopWindow } from '../src/devin/projectMatch';

const WINDOWS: DesktopWindow[] = [
  { project: 'ConnectAgentToTelegram', title: 'ConnectAgentToTelegram - Devin - README.md' },
  { project: 'Silver Utilizar Silver CD 2 ISO', title: 'Silver Utilizar Silver CD 2 ISO - Devin' },
  { project: 'Jellyfin.Plugin.Torrent', title: 'Jellyfin.Plugin.Torrent - Devin' },
  { project: 'MilioLab', title: 'MilioLab - Devin' }
];

describe('matchProject', () => {
  it('encuentra el proyecto nombrado en la orden', () => {
    const match = matchProject('en Silver, continúa con lo que estabas haciendo', WINDOWS);
    expect(match?.window.project).toBe('Silver Utilizar Silver CD 2 ISO');
  });

  it('no distingue mayúsculas ni acentos', () => {
    const match = matchProject('SIGUE CON JELLYFIN por favor', WINDOWS);
    expect(match?.window.project).toBe('Jellyfin.Plugin.Torrent');
  });

  it('ignora palabras comunes y cortas', () => {
    expect(matchProject('continúa con el proyecto de la web', WINDOWS)).toBeNull();
  });

  it('elige la coincidencia con más peso cuando hay varias', () => {
    const windows: DesktopWindow[] = [
      { project: 'Silver Utilizar Silver CD 2 ISO', title: 'a' },
      { project: 'Silver', title: 'b' }
    ];
    const match = matchProject('revisa Silver Utilizar por favor', windows);
    expect(match?.window.project).toBe('Silver Utilizar Silver CD 2 ISO');
  });

  it('devuelve null si no menciona ningún proyecto', () => {
    expect(matchProject('arregla el bug del login', WINDOWS)).toBeNull();
  });

  it('devuelve null sin ventanas', () => {
    expect(matchProject('en Silver', [])).toBeNull();
  });
});
