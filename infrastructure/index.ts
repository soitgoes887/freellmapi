import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

const config = new pulumi.Config();
const image = config.require("image"); // e.g. anicu/freellmapi:2026.05.05-abc123f-7
const host = config.require("host");   // e.g. freellmapi.ddns.net
const namespaceName = config.require("namespace"); // e.g. freellmapi-prod / freellmapi-dev
const kubeconfigContext = config.get("kubeconfigContext") || "kubernetes-admin@kubernetes";
const imagePullPolicy = config.get("imagePullPolicy") || "Always";
const allowlist = config.get("allowlist") || "0.0.0.0/0,::/0";
const storageSize = config.get("storageSize") || "1Gi";

const encryptionKey = config.requireSecret("encryptionKey");

const k8sProvider = new k8s.Provider("k8s-provider", {
    context: kubeconfigContext,
    enableServerSideApply: true,
});

const namespace = new k8s.core.v1.Namespace("freellmapi-namespace", {
    metadata: { name: namespaceName },
}, { provider: k8sProvider });

const envSecret = new k8s.core.v1.Secret("freellmapi-secret", {
    metadata: { name: "freellmapi-env", namespace: namespaceName },
    type: "Opaque",
    stringData: {
        ENCRYPTION_KEY: encryptionKey,
    },
}, { provider: k8sProvider, dependsOn: [namespace] });

const dataPvc = new k8s.core.v1.PersistentVolumeClaim("freellmapi-data", {
    metadata: { name: "freellmapi-data", namespace: namespaceName },
    spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: "hcloud-volumes",
        resources: { requests: { storage: storageSize } },
    },
}, { provider: k8sProvider, dependsOn: [namespace] });

const deployment = new k8s.apps.v1.Deployment("freellmapi-deployment", {
    metadata: {
        name: "freellmapi",
        namespace: namespaceName,
        labels: { app: "freellmapi" },
        annotations: { "pulumi.com/patchForce": "true" },
    },
    spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: { app: "freellmapi" } },
        template: {
            metadata: { labels: { app: "freellmapi" } },
            spec: {
                securityContext: {
                    runAsUser: 1000,
                    runAsGroup: 1000,
                    fsGroup: 1000,
                },
                containers: [{
                    name: "freellmapi",
                    image: image,
                    imagePullPolicy: imagePullPolicy,
                    ports: [{ containerPort: 3001 }],
                    envFrom: [{ secretRef: { name: "freellmapi-env" } }],
                    env: [{ name: "PORT", value: "3001" }],
                    volumeMounts: [{
                        name: "data",
                        mountPath: "/app/server/data",
                    }],
                    resources: {
                        requests: { memory: "128Mi", cpu: "50m" },
                        limits: { memory: "512Mi", cpu: "500m" },
                    },
                    livenessProbe: {
                        tcpSocket: { port: 3001 },
                        initialDelaySeconds: 20,
                        periodSeconds: 15,
                    },
                    readinessProbe: {
                        httpGet: { path: "/api/health", port: 3001 },
                        initialDelaySeconds: 5,
                        periodSeconds: 5,
                    },
                }],
                volumes: [{
                    name: "data",
                    persistentVolumeClaim: { claimName: "freellmapi-data" },
                }],
            },
        },
    },
}, { provider: k8sProvider, dependsOn: [namespace, envSecret, dataPvc] });

const service = new k8s.core.v1.Service("freellmapi-service", {
    metadata: { name: "freellmapi", namespace: namespaceName },
    spec: {
        type: "ClusterIP",
        selector: { app: "freellmapi" },
        ports: [{ port: 3001, targetPort: 3001 }],
    },
}, { provider: k8sProvider, dependsOn: [namespace] });

const ingress = new k8s.networking.v1.Ingress("freellmapi-ingress", {
    metadata: {
        name: "freellmapi",
        namespace: namespaceName,
        annotations: {
            "cert-manager.io/cluster-issuer": "letsencrypt-prod",
            "nginx.ingress.kubernetes.io/whitelist-source-range": allowlist,
            "nginx.ingress.kubernetes.io/proxy-body-size": "10m",
            "nginx.ingress.kubernetes.io/proxy-read-timeout": "600",
            "nginx.ingress.kubernetes.io/proxy-send-timeout": "600",
        },
    },
    spec: {
        ingressClassName: "nginx",
        tls: [{ hosts: [host], secretName: `${namespaceName}-tls` }],
        rules: [{
            host: host,
            http: {
                paths: [{
                    path: "/",
                    pathType: "Prefix",
                    backend: { service: { name: "freellmapi", port: { number: 3001 } } },
                }],
            },
        }],
    },
}, { provider: k8sProvider, dependsOn: [namespace, service] });

export const k8sNamespace = namespace.metadata.name;
export const k8sImage = image;
export const k8sHost = host;
export const k8sUrl = `https://${host}`;
