import { useEffect, useState } from 'react';

function getGridLayout() {
    const width = window.innerWidth;
    if (width > 1680) return { regularColumns: [3, 4], compactColumns: 8 };
    if (width >= 1680) return { regularColumns: [3], compactColumns: 8 };
    if (width >= 1440) return { regularColumns: [3], compactColumns: 7 };
    if (width >= 1280) return { regularColumns: [2], compactColumns: 6 };
    if (width > 480) return { regularColumns: [2], compactColumns: 5 };
    return { regularColumns: [3, 4], compactColumns: null };
}

export default function usePlantGridLayout() {
    const [layout, setLayout] = useState(getGridLayout);

    useEffect(() => {
        const handleResize = () => setLayout(getGridLayout());
        window.addEventListener('resize', handleResize);
        handleResize();
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    return layout;
}
