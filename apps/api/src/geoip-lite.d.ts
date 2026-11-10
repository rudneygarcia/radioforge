declare module 'geoip-lite' {
  interface Lookup {
    country: string;
    region: string;
    city: string;
  }
  const geoip: { lookup(ip: string): Lookup | null };
  export default geoip;
}
