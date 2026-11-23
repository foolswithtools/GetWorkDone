// The Prometheus datasource every SLO, rule and panel queries. Grafana Cloud stacks name their hosted
// metrics datasource `grafanacloud-prom`; GRAFANA_PROM_DATASOURCE_UID overrides it.

export const DEFAULT_DATASOURCE_UID = 'grafanacloud-prom';
