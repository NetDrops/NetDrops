from diagrams import Diagram, Cluster, Edge
from diagrams.onprem.network import Nginx
from diagrams.onprem.dns import Coredns
from diagrams.programming.framework import React, Spring, Flutter

graph_attr = {
    "fontsize": "20",
    "bgcolor": "white",
    "ranksep": "1.5",
    "nodesep": "1.0",
    "splines": "polyline",
    "compound": "true",
}

with Diagram(
    "NetDrops Server Architecture",
    filename="docs/netdrops_architecture",
    show=False,
    outformat="png",
    direction="LR",
    graph_attr=graph_attr,
):
    with Cluster("Clients", graph_attr={"margin": "30"}):
        web = React("Web")
        mobile = Flutter("Mobile")
        # 수직 정렬 강제
        web - Edge(style="invis") - mobile

    dns = Coredns("Gabia DNS\nnetdrops.cloud")

    with Cluster("Raspberry Pi", graph_attr={"margin": "30"}):
        nginx = Nginx("Nginx + SSL")
        spring = Spring("Spring Boot\n(WebSocket)")

    web >> Edge(label="WSS", color="royalblue", style="bold") >> dns
    mobile >> Edge(label="WSS", color="royalblue", style="bold") >> dns
    dns >> Edge(color="gray") >> nginx
    nginx >> Edge(label="Proxy Pass", color="darkorange", style="bold") >> spring
